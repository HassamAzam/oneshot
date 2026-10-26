import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approverLine, designApprovalRequestBody, designApprovedRecordBody, designAttachments,
  designDeliverableRefusal, designGateApplies,
} from './reviewgate.js';
import { artifactDir, designFlowOwedFile, phases } from '../lib/config.js';
import { gradeDesignNote, roundPasses } from '../lib/designeval.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const screen = {
  id: 'approvals-inbox',
  name: 'Approvals inbox',
  purpose: 'A manager clears pending requests',
  states: ['default', 'empty'],
  mockupHtml: 'design/approvals-inbox.html',
  screenshot: 'design/approvals-inbox.png',
  before: 'design/approvals-inbox--before.png',
  note: 'Defaults to the Pending filter',
};

const design = {
  applicable: true,
  rationale: 'Two screens change',
  flowChange: true,
  tokensFile: 'design/tokens.css',
  screens: [screen],
  prototype: { entry: 'design/flow.html', video: 'design/flow.webm' },
  decisions: ['Bulk approve is one confirm, not per row'],
  newPatterns: ['A compact status chip the product does not have'],
  openQuestions: [{ q: 'Can a lead approve their own?', recommendation: 'No' }],
};

test('the design phase is gated on the Design label', () => {
  const p = phases().find((x) => x.name === 'design');
  assert.ok(p, 'the design phase is missing from config/phases.json');
  assert.equal(p.labelGated, 'Design');
  // Sorting is the ONLY thing `n` does, and this is the property that matters:
  // design runs after research and before plan.
  const order = phases().map((x) => x.name);
  assert.ok(order.indexOf('design') > order.indexOf('research'));
  assert.ok(order.indexOf('design') < order.indexOf('plan'));
});

test('the gate arms on the label, case-insensitively, and not otherwise', () => {
  assert.equal(designGateApplies(['Loop', 'Design']), true);
  assert.equal(designGateApplies(['loop', 'design']), true);
  assert.equal(designGateApplies(['Loop']), false);
  assert.equal(designGateApplies([]), false);
  // `Review` is a different question — how much scrutiny the CODE needs.
  assert.equal(designGateApplies(['Loop', 'Review']), false);
});

test('the request renders screens, decisions, new patterns and open questions', () => {
  const body = designApprovalRequestBody(0, design);
  assert.match(body, /\*\*Screens\*\* \(1\)/);
  assert.match(body, /\*\*Approvals inbox\*\* — A manager clears pending requests/);
  assert.match(body, /_\(default, empty\)_/);
  assert.match(body, /Defaults to the Pending filter/);
  assert.match(body, /\*\*Decisions worth your attention\*\*/);
  assert.match(body, /\*\*New — needs approval\*\*/);
  assert.match(body, /Can a lead approve their own\? — _recommended: No_/);
  assert.match(body, /Only DESIGN may sign this off/);
});

test('the product owner may sign off a design, and not a plan', () => {
  assert.match(approverLine('design'), /`@muhammad\.nouman`/);
  assert.doesNotMatch(approverLine('plan'), /muhammad\.nouman/);
});

test('the request offers the walkthrough and the prototype only while both are on disk', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    [design.prototype.entry, design.prototype.video].forEach((rel) => writeFileSync(join(dir, rel), 'x'));
    const flow = designApprovalRequestBody(TMP_IID, design);
    assert.match(flow, /silent walkthrough is attached/);
    assert.match(flow, /clickable\s+prototype/);
    assert.doesNotMatch(flow, /follow in a later change/);

    // The sentence used to render from `flowChange` alone, so a design.json
    // whose prototype was never built promised a reviewer two files that
    // `designAttachments` silently drops — which is what any re-arm of such a
    // gate still does, since the deliverable check only runs on a fresh result.
    rmSync(join(dir, design.prototype.video), { force: true });
    assert.match(designApprovalRequestBody(TMP_IID, design), /no\s+walkthrough recording/);
    rmSync(join(dir, design.prototype.entry), { force: true });
    assert.match(designApprovalRequestBody(TMP_IID, design), /no prototype or walkthrough attached/);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a design with no prototype does not call itself a single screen', () => {
  const flat = designApprovalRequestBody(0, {
    ...design, flowChange: false, prototype: null, screens: [screen, { ...screen, id: 'second' }],
  });
  assert.match(flat, /no prototype or walkthrough attached/);
  assert.doesNotMatch(flat, /[Ss]ingle screen/);
});

test('an empty or absent design does not throw and renders nothing invented', () => {
  const body = designApprovalRequestBody(0, null);
  assert.match(body, /\*\*Screens\*\* \(0\)/);
  assert.match(body, /_\(none recorded\)_/);
  assert.doesNotMatch(body, /New — needs approval/);
  assert.doesNotMatch(body, /Open questions/);
});

test('HTML in model-authored fields is escaped, not rendered', () => {
  const body = designApprovalRequestBody(0, {
    ...design,
    decisions: ['Wrap the total in a <strong> so it reads first'],
  });
  assert.match(body, /&lt;strong&gt;/);
  assert.doesNotMatch(body, /<strong>/);
});

test('the audit record names what was approved, including the new patterns', () => {
  const rec = designApprovedRecordBody(design);
  assert.match(rec, /proceeding to `plan`/);
  assert.match(rec, /Approved screens: `Approvals inbox`/);
  assert.match(rec, /A compact status chip/);
});

test('attachments skip files that are not on disk rather than failing the gate', () => {
  // Nothing was written for iid 0, so every path misses. The gate must still
  // be able to arm: a missing screenshot costs the picture, never the ask.
  assert.deepEqual(designAttachments(0, design), []);
  assert.deepEqual(designAttachments(0, null), []);
});

// A throwaway iid no real run will ever claim, removed again below.
const TMP_IID = 999999;

test('attachments read before-then-after per screen, and keep colliding names apart', () => {
  const dir = artifactDir(TMP_IID);
  const write = (rel: string): void => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'x');
  };
  try {
    const two = {
      ...design,
      screens: [
        { ...screen, before: 'design/a/shot.png', screenshot: 'design/b/shot.png' },
        { ...screen, id: 'second', before: '', screenshot: 'design/second.png' },
      ],
    };
    ['design/a/shot.png', 'design/b/shot.png', 'design/second.png'].forEach(write);

    const got = designAttachments(TMP_IID, two);
    // Order IS the argument: today's screen then the proposal, per screen.
    assert.deepEqual(got.map((a) => a.name), [
      'shot.png', 'design-b-shot.png', 'second.png',
    ]);
    assert.equal(new Set(got.map((a) => a.name)).size, got.length);
    assert.deepEqual(got.map((a) => a.mime), ['image/png', 'image/png', 'image/png']);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a flow change attaches the walkthrough after the screens, then the clickable file', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    [screen.before, screen.screenshot, design.prototype.video, design.prototype.entry]
      .forEach((rel) => writeFileSync(join(dir, rel), 'x'));
    const got = designAttachments(TMP_IID, design);
    assert.deepEqual(got.map((a) => a.name), [
      'approvals-inbox--before.png', 'approvals-inbox.png', 'flow.webm', 'flow.html',
    ]);
    assert.deepEqual(got.map((a) => a.mime), ['image/png', 'image/png', 'video/webm', 'text/html']);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('each screen\'s mockup HTML is attached after the media, and the prototype last', () => {
  // The pictures and the walkthrough render inline and are read first; the
  // mockup HTML is the thing a reviewer opens when a picture left a question,
  // so it comes after them as its own block rather than interleaved, with the
  // whole journey's prototype after the single screens.
  const dir = artifactDir(TMP_IID);
  const write = (rel: string): void => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, 'x');
  };
  try {
    const two = {
      ...design,
      screens: [
        { ...screen, before: 'design/one--before.png', screenshot: 'design/one.png', mockupHtml: 'design/one.html' },
        { ...screen, id: 'second', before: '', screenshot: 'design/two.png', mockupHtml: 'design/two.html' },
      ],
    };
    [
      'design/one--before.png', 'design/one.png', 'design/two.png', 'design/one.html', 'design/two.html',
      design.prototype.video, design.prototype.entry,
    ].forEach(write);

    const got = designAttachments(TMP_IID, two);
    assert.deepEqual(got.map((a) => a.name), [
      'one--before.png', 'one.png', 'two.png', 'flow.webm', 'one.html', 'two.html', 'flow.html',
    ]);
    assert.deepEqual(got.map((a) => a.mime), [
      'image/png', 'image/png', 'image/png', 'video/webm', 'text/html', 'text/html', 'text/html',
    ]);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a screen with no "before" contributes only its proposal', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, 'design/only.png'), 'x');
    const got = designAttachments(TMP_IID, {
      ...design,
      screens: [{ ...screen, before: '', screenshot: 'design/only.png' }],
    });
    assert.deepEqual(got.map((a) => a.name), ['only.png']);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

// The gate arms on what the phase SAYS it drew, and `designAttachments` drops a
// file disk does not have without a word. Together that is a gate comment
// naming five screens with no images under it — a reviewer parked in front of
// nothing. These cover the check that refuses that before the gate arms.
test('a design whose renders are not on disk is refused, not armed', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    const refusal = designDeliverableRefusal(TMP_IID, design);
    assert.ok(refusal, 'a design reporting a screen it never rendered must be refused');
    assert.match(refusal ?? '', /none of their renders are on disk/);
    assert.match(refusal ?? '', /approvals-inbox/);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a design whose renders ARE on disk passes', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    [screen.screenshot, design.prototype.entry, design.prototype.video]
      .forEach((rel) => writeFileSync(join(dir, rel), 'x'));
    assert.equal(designDeliverableRefusal(TMP_IID, design), null);
    assert.equal(designDeliverableRefusal(TMP_IID, { ...design, flowChange: false, prototype: null }), null);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

// A flow change drawn as stills, with no prototype and no walkthrough, and a
// gate that armed on them anyway.
test('a flow change with every render but no prototype is refused, naming both files', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, screen.screenshot), 'x');
    const refusal = designDeliverableRefusal(TMP_IID, { ...design, prototype: null });
    assert.match(refusal ?? '', /flow change, and its clickable prototype and walkthrough video are not on disk/);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a flow change reporting no screens at all is still refused for its deliverables', () => {
  // `screens: []` is schema-valid — there is no `minItems` — and it used to
  // return early from the screen check before the flow check could be reached,
  // so this answer recorded the phase `ok`.
  const refusal = designDeliverableRefusal(TMP_IID, { ...design, screens: [], prototype: null });
  assert.match(refusal ?? '', /flow change, and its clickable prototype and walkthrough video are not on disk/);
});

test('dropping the flow-change claim after the guard refused it does not clear the debt', () => {
  const dir = artifactDir(TMP_IID);
  const owed = designFlowOwedFile(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, screen.screenshot), 'x');
    const withdrawn = { ...design, flowChange: false, prototype: null };
    // On its own this is a complete answer, and must stay one.
    assert.equal(designDeliverableRefusal(TMP_IID, withdrawn), null);
    // With the guard's record of a refusal, clearing the field buys nothing —
    // which is the whole point, since the field is the session's to write.
    mkdirSync(dirname(owed), { recursive: true });
    writeFileSync(owed, '1');
    assert.match(designDeliverableRefusal(TMP_IID, withdrawn) ?? '',
      /then stopped reporting one, and its clickable prototype and walkthrough video are not on disk/);
    // `applicable: false` is still a complete answer: there is no design.
    assert.equal(designDeliverableRefusal(TMP_IID, { ...withdrawn, applicable: false }), null);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
    rmSync(owed, { force: true });
  }
});

test('a flow change missing only its walkthrough is refused for the walkthrough alone', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    [screen.screenshot, design.prototype.entry].forEach((rel) => writeFileSync(join(dir, rel), 'x'));
    const refusal = designDeliverableRefusal(TMP_IID, design);
    assert.match(refusal ?? '', /its walkthrough video is not on disk/);
    assert.doesNotMatch(refusal ?? '', /clickable prototype/);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('a partial render is still refused, and names only the screens that are missing', () => {
  const dir = artifactDir(TMP_IID);
  try {
    mkdirSync(join(dir, 'design'), { recursive: true });
    writeFileSync(join(dir, screen.screenshot), 'x');
    const two = {
      ...design,
      screens: [screen, { ...screen, id: 'second', screenshot: 'design/second.png' }],
    };
    const refusal = designDeliverableRefusal(TMP_IID, two);
    assert.match(refusal ?? '', /1 of their renders/);
    assert.match(refusal ?? '', /second/);
    assert.doesNotMatch(refusal ?? '', /approvals-inbox/);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

test('nothing to deliver is not a refusal — applicable:false and an empty list both pass', () => {
  // A design that correctly found no UI to draw is a complete answer, and
  // refusing it would block exactly the runs the phase is meant to wave through.
  // An empty list owes nothing of its OWN accord; paired with a flow change it
  // still owes the flow, which the test above covers.
  assert.equal(designDeliverableRefusal(TMP_IID, { ...design, applicable: false }), null);
  assert.equal(designDeliverableRefusal(
    TMP_IID, { ...design, screens: [], flowChange: false, prototype: null },
  ), null);
  assert.equal(designDeliverableRefusal(TMP_IID, null), null);
});

test('what the gate attaches passes the live design eval: every before, screenshot and html is linked', () => {
  const dir = artifactDir(TMP_IID);
  try {
    const files = [screen.mockupHtml, screen.screenshot, screen.before, design.prototype.entry, design.prototype.video];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'x');
    }
    const body = designAttachments(TMP_IID, design)
      .map((a) => `[${a.name}](/uploads/0123abcd/${a.name})`)
      .join('\n\n');
    const graded = gradeDesignNote(design, body, () => true);
    assert.deepEqual(graded.map((g) => g.file),
      [screen.before, screen.screenshot, screen.mockupHtml, design.prototype.entry]);
    assert.equal(roundPasses(graded), true);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

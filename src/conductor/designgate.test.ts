import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  designApprovalRequestBody, designApprovedRecordBody, designAttachments, designGateApplies,
} from './reviewgate.js';
import { artifactDir, phases } from '../lib/config.js';
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
  prototype: { entry: 'design/prototype/index.html', video: 'design/walkthrough.webm' },
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
  const body = designApprovalRequestBody(design);
  assert.match(body, /\*\*Screens\*\* \(1\)/);
  assert.match(body, /\*\*Approvals inbox\*\* — A manager clears pending requests/);
  assert.match(body, /_\(default, empty\)_/);
  assert.match(body, /Defaults to the Pending filter/);
  assert.match(body, /\*\*Decisions worth your attention\*\*/);
  assert.match(body, /\*\*New — needs approval\*\*/);
  assert.match(body, /Can a lead approve their own\? — _recommended: No_/);
  assert.match(body, /Only DEV may sign this off/);
});

test('a flow change offers the prototype and a single screen does not', () => {
  assert.match(designApprovalRequestBody(design), /clickable\s+prototype/);
  const flat = designApprovalRequestBody({ ...design, flowChange: false, prototype: null });
  assert.match(flat, /no flow change, so there is no prototype/);
  assert.doesNotMatch(flat, /download it and open it/);
});

test('an empty or absent design does not throw and renders nothing invented', () => {
  const body = designApprovalRequestBody(null);
  assert.match(body, /\*\*Screens\*\* \(0\)/);
  assert.match(body, /_\(none recorded\)_/);
  assert.doesNotMatch(body, /New — needs approval/);
  assert.doesNotMatch(body, /Open questions/);
});

test('HTML in model-authored fields is escaped, not rendered', () => {
  const body = designApprovalRequestBody({
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
      prototype: { entry: 'design/prototype/index.html', video: 'design/walk.webm' },
    };
    ['design/a/shot.png', 'design/b/shot.png', 'design/second.png',
      'design/prototype/index.html', 'design/walk.webm'].forEach(write);

    const got = designAttachments(TMP_IID, two);
    // Order IS the argument: today's screen then the proposal, per screen,
    // then the walkthrough, then the clickable file last.
    assert.deepEqual(got.map((a) => a.name), [
      'shot.png', 'design-b-shot.png', 'second.png', 'walk.webm', 'index.html',
    ]);
    assert.equal(new Set(got.map((a) => a.name)).size, got.length);
    assert.deepEqual(
      got.map((a) => a.mime),
      ['image/png', 'image/png', 'image/png', 'video/webm', 'text/html'],
    );
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
      prototype: null,
      screens: [{ ...screen, before: '', screenshot: 'design/only.png' }],
    });
    assert.deepEqual(got.map((a) => a.name), ['only.png']);
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true });
  }
});

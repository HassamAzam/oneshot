/**
 * The design gate records THAT a human approved, and used to record nothing
 * about WHAT. `runner.ts` arms that gate on `!designApproval?.approved`, so it
 * ran exactly once: anything that rewrote design.json afterwards inherited the
 * sign-off, plan built to a design nobody had seen, and `ui-evidence` captioned
 * the result "a human approved these screens before the code was written".
 *
 * These pin the digest that tells the two apart, and the backward-compatible
 * hole it must deliberately leave open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalCovers, approvedDigestFor, gateSubjectDigest, requestCovers, type ReviewGateState,
} from './artifacts.js';

const approved = (over: Partial<ReviewGateState> = {}): ReviewGateState => ({
  requestTs: '2026-09-24T00:00:00Z', requestNoteId: 1, approved: true, feedback: [], ...over,
});

test('key order is not a change a reviewer could see, so it is not a change', () => {
  const a = { screens: [{ id: 's1', name: 'List' }], applicable: true };
  const b = { applicable: true, screens: [{ name: 'List', id: 's1' }] };
  assert.equal(gateSubjectDigest(a), gateSubjectDigest(b));
});

test('a changed screen changes the digest', () => {
  const a = { screens: [{ id: 's1', name: 'List' }] };
  const b = { screens: [{ id: 's1', name: 'Detail' }] };
  assert.notEqual(gateSubjectDigest(a), gateSubjectDigest(b));
});

test('array order IS a change — two screens swapped is a different design', () => {
  const a = { screens: [{ id: 's1' }, { id: 's2' }] };
  const b = { screens: [{ id: 's2' }, { id: 's1' }] };
  assert.notEqual(gateSubjectDigest(a), gateSubjectDigest(b));
});

test('an unapproved gate is covered — the caller decides what unapproved means', () => {
  // approvalCovers answers "does the sign-off still apply", not "is there one".
  assert.equal(approvalCovers(approved({ approved: false }), { any: 'thing' }), true);
  assert.equal(approvalCovers(undefined, { any: 'thing' }), true);
});

test('an approval stamped before digests existed still covers', () => {
  // The upgrade hole, left open on purpose: re-arming every in-flight run's
  // gate on deploy would be a worse bug than the one this closes.
  const state = approved();
  assert.equal(state.approvedDigest, undefined);
  assert.equal(approvalCovers(state, { screens: ['anything at all'] }), true);
});

test('an approval covers the design it was given', () => {
  const design = { applicable: true, screens: [{ id: 's1', name: 'List' }] };
  const state = approved({ approvedDigest: gateSubjectDigest(design) });
  assert.equal(approvalCovers(state, design), true);
});

test('an approval does not cover a design rewritten after the sign-off', () => {
  // The bug in one test: approved v1, design.json is now v2.
  const v1 = { applicable: true, screens: [{ id: 's1', name: 'List' }] };
  const v2 = { applicable: true, screens: [{ id: 's1', name: 'List' }, { id: 's2', name: 'Detail' }] };
  const state = approved({ approvedDigest: gateSubjectDigest(v1) });
  assert.equal(approvalCovers(state, v2), false);
});

test('a design that vanished is not silently treated as approved', () => {
  const v1 = { applicable: true, screens: [{ id: 's1' }] };
  const state = approved({ approvedDigest: gateSubjectDigest(v1) });
  assert.equal(approvalCovers(state, undefined), false);
});

// ------------------------------------------- the window between request and reply

const V1 = { applicable: true, screens: [{ id: 's1', name: 'List' }] };
const V2 = { applicable: true, screens: [{ id: 's1', name: 'List' }, { id: 's2', name: 'Detail' }] };

const standing = (over: Partial<ReviewGateState> = {}): ReviewGateState => ({
  requestTs: null, requestNoteId: 7, approved: false, feedback: [], ...over,
});

test('a request still covers the design it showed', () => {
  assert.equal(requestCovers(standing({ requestedDigest: gateSubjectDigest(V1) }), V1), true);
});

test('a design rewritten while its request stood is not what the request showed', () => {
  // Request posted for v1, design.json rewritten to v2 before anyone replied:
  // an `approved` on that request is a verdict on v1, so the gate must re-ask.
  assert.equal(requestCovers(standing({ requestedDigest: gateSubjectDigest(V1) }), V2), false);
});

test('nothing standing, no tracked subject, or a pre-upgrade request all count as covered', () => {
  assert.equal(requestCovers(standing({ requestNoteId: null, requestedDigest: gateSubjectDigest(V1) }), V2), true);
  assert.equal(requestCovers(standing({ requestedDigest: gateSubjectDigest(V1) }), undefined), true);
  assert.equal(requestCovers(standing(), V2), true);
});

test('an approval is stamped with what the request showed, not what design.json holds now', () => {
  const state = standing({ requestedDigest: gateSubjectDigest(V1) });
  const stamped = approvedDigestFor(state, V2);
  assert.equal(stamped, gateSubjectDigest(V1));
  assert.equal(approvalCovers({ ...state, approved: true, approvedDigest: stamped }, V2), false);
});

test('a request posted before requestedDigest existed stamps the current design', () => {
  assert.equal(approvedDigestFor(standing(), V2), gateSubjectDigest(V2));
});

test('a gate that tracks no subject stamps nothing', () => {
  assert.equal(approvedDigestFor(standing({ requestedDigest: gateSubjectDigest(V1) }), undefined), undefined);
});

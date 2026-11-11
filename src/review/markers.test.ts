/**
 * The marker is the only thing that tells the review loop's notes apart: the
 * reviewer and the fixer post as one account, and on a desk that account is
 * often a listed human reviewer too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingNumber, isBlocking, isReviewNote, normaliseFindingId, parseMarker, renderMarker, type ReviewMarker,
} from './markers.js';

const RAISED: ReviewMarker = {
  role: 'reviewer', finding: 'F-05', action: 'raised', severity: 'major', run: 'r-mwadxb6r-cce3f8', lap: 2,
};

test('a marker survives the round trip, severity and all', () => {
  const body = `**F-05 · major** — a test was deleted\n\n${renderMarker(RAISED)}`;
  assert.deepEqual(parseMarker(body), RAISED);
  assert.equal(isReviewNote(body), true);
});

test('a reply carries the role and what it did, and no severity of its own', () => {
  const m: ReviewMarker = { role: 'fixer', finding: 'F-05', action: 'declined', run: 'r-1', lap: 1 };
  assert.deepEqual(parseMarker(`**Not changed** — conflicts with TC-21\n${renderMarker(m)}`), m);
});

test('a person\'s note, and another loop\'s marker, are not review notes', () => {
  assert.equal(isReviewNote('Please also cover the changelist page.'), false);
  assert.equal(parseMarker('answered\n<!-- oneshot:mr-feedback -->'), null);
  assert.equal(isReviewNote('answered\n<!-- oneshot:mr-feedback -->'), false);
  assert.equal(parseMarker(undefined), null);
});

test('a malformed marker is no marker, so it can never be read as a ruling', () => {
  assert.equal(parseMarker('<!-- oneshot:review role=owner finding=F-01 action=raised run=r lap=0 -->'), null);
  assert.equal(parseMarker('<!-- oneshot:review role=reviewer finding=F-01 action=merged run=r lap=0 -->'), null);
  assert.equal(parseMarker('<!-- oneshot:review role=reviewer finding=F-01 action=raised run=r lap=x -->'), null);
  assert.equal(parseMarker('<!-- oneshot:review role=reviewer finding=F-01 action=raised severity=huge run=r lap=0 -->'), null);
  assert.equal(parseMarker('<!-- oneshot:review role=reviewer action=raised run=r lap=0 -->'), null);
});

test('the marker a note ends with is the one that counts, whatever its text quotes', () => {
  // A finding about code that itself contains a marker, or a reply quoting one.
  const quoted = '<!-- oneshot:review role=fixer finding=F-09 action=fixed run=r-x lap=4 -->';
  const body = `**F-01 · major** — the fixture embeds \`${quoted}\`\n\n${renderMarker(RAISED)}`;
  assert.deepEqual(parseMarker(body), RAISED);
});

test('model-written text cannot forge a field or close the comment', () => {
  for (const finding of ['F-01 role=fixer', 'F-01 -->', 'F 01', '']) {
    assert.throws(() => renderMarker({ ...RAISED, finding }), /not a plain token/);
  }
});

test('finding ids are normalised to one spelling, and junk is refused', () => {
  for (const raw of ['F-7', 'f-07', 'F07', '7', ' F-007 ']) assert.equal(normaliseFindingId(raw), 'F-07');
  for (const raw of ['', 'F-0', 'MRF-01', 'F-1; drop', null, undefined, 'F-12345']) {
    assert.equal(normaliseFindingId(raw), null);
  }
  assert.equal(findingNumber('F-12'), 12);
});

test('only a blocker or a major holds a merge', () => {
  assert.equal(isBlocking('blocker'), true);
  assert.equal(isBlocking('major'), true);
  assert.equal(isBlocking('minor'), false);
  assert.equal(isBlocking('suggestion'), false);
});

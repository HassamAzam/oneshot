/**
 * The escaped-defect window, tested against the real board history of
 * erp#8781 — the ticket that motivated it. Oneshot shipped it, manual testing
 * on stage found that the division ignored assigned limits, a second MR fixed
 * it, and QA signed off. Every synthetic case below is a mutation of that one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BOARD_LABELS, MIN_FOR_RATE, escapeRate, escapeRecord, type EscapeRecord, type LabelEvent,
} from './escapes.js';

const t = (iso: string): number => Date.parse(iso);
const ev = (iso: string, action: 'add' | 'remove', label: string, by = 'anosha.saeed'): LabelEvent =>
  ({ at: t(iso), action, label, by });

/** erp#8781, verbatim from `resource_label_events` on project 304. */
const ERP_8781: LabelEvent[] = [
  ev('2026-10-01T13:27Z', 'add', 'bug', 'usman.nasir'),
  ev('2026-10-01T13:27Z', 'add', 'Bug', 'usman.nasir'),
  ev('2026-10-01T13:27Z', 'add', 'Loop', 'usman.nasir'),
  ev('2026-10-03T00:22Z', 'add', 'In Review', 'usman.nasir'),
  ev('2026-10-13T15:00Z', 'add', 'In QA', 'project_304_bot'),
  ev('2026-10-13T15:00Z', 'remove', 'In Review', 'project_304_bot'),
  ev('2026-10-13T15:13Z', 'add', 'AnoshaTesting'),
  ev('2026-10-13T15:16Z', 'add', 'Merged', 'usman.nasir'),
  ev('2026-10-13T15:16Z', 'remove', 'Loop', 'usman.nasir'),
  ev('2026-10-15T17:13Z', 'remove', 'In QA'),
  ev('2026-10-15T17:14Z', 'add', 'QA Issues'),
  ev('2026-10-15T20:30Z', 'add', 'In QA', 'project_304_bot'),
  ev('2026-10-15T20:30Z', 'remove', 'QA Issues', 'project_304_bot'),
  ev('2026-10-15T21:58Z', 'remove', 'In QA'),
  ev('2026-10-15T21:58Z', 'add', 'Ready For Deployment'),
  ev('2026-10-15T23:42Z', 'add', 'Minor', 'hira.ijaz'),
];

test('erp#8781 reads as one escape, bracketed by the merge and the sign-off', () => {
  const r = escapeRecord(ERP_8781);
  assert.equal(r.verdict, 'escaped');
  assert.equal(r.openedAt, t('2026-10-13T15:16Z'));
  assert.equal(r.closedAt, t('2026-10-15T21:58Z'));
  assert.equal(r.rounds.length, 1);
  assert.equal(r.rounds[0]!.at, t('2026-10-15T17:14Z'));
  assert.equal(r.rounds[0]!.by, 'anosha.saeed');
  assert.equal(r.signOffWithdrawn, false);
});

test('page order does not change the verdict', () => {
  const shuffled = [...ERP_8781].reverse();
  assert.deepEqual(escapeRecord(shuffled), escapeRecord(ERP_8781));
});

test('a ticket QA signed off with nothing flagged is clean', () => {
  const clean = ERP_8781.filter((e) => e.label !== 'QA Issues');
  const r = escapeRecord(clean);
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.rounds, []);
});

test('a shipped ticket still in QA is open, never counted clean', () => {
  const stillTesting = ERP_8781.filter((e) => e.label !== 'Ready For Deployment' && e.label !== 'QA Issues');
  const r = escapeRecord(stillTesting);
  assert.equal(r.verdict, 'open');
  assert.equal(r.closedAt, null);
});

test('a ticket that never merged is excluded, not counted clean', () => {
  const r = escapeRecord(ERP_8781.filter((e) => e.label !== 'Merged'));
  assert.equal(r.verdict, 'not-shipped');
  assert.equal(r.openedAt, null);
});

test('defects flagged BEFORE the merge are not escapes from shipped code', () => {
  const early = [
    ev('2026-10-10T09:00Z', 'add', 'QA Issues'),
    ev('2026-10-13T15:16Z', 'add', 'Merged', 'usman.nasir'),
    ev('2026-10-15T21:58Z', 'add', 'Ready For Deployment'),
  ];
  assert.equal(escapeRecord(early).verdict, 'clean');
});

test('defects flagged after sign-off fall outside the window', () => {
  const later = [...ERP_8781.filter((e) => e.label !== 'QA Issues'),
    ev('2026-10-20T10:00Z', 'add', 'QA Issues')];
  assert.equal(escapeRecord(later).verdict, 'clean');
});

test('two rounds of findings are kept apart from one', () => {
  const twice = [...ERP_8781, ev('2026-10-15T20:45Z', 'add', 'QA Issues')];
  const r = escapeRecord(twice);
  assert.equal(r.rounds.length, 2);
  assert.equal(r.verdict, 'escaped');
});

test('a withdrawn sign-off is flagged but does not move the closing edge', () => {
  const disputed = [...ERP_8781, ev('2026-10-16T09:00Z', 'remove', 'Ready For Deployment')];
  const r = escapeRecord(disputed);
  assert.equal(r.signOffWithdrawn, true);
  assert.equal(r.closedAt, t('2026-10-15T21:58Z'));
});

test('label names are configurable, because another board will not use these', () => {
  const renamed = ERP_8781.map((e) => ({
    ...e,
    label: e.label === 'QA Issues' ? 'Bugs Found' : e.label === 'Merged' ? 'Shipped' : e.label,
  }));
  const r = escapeRecord(renamed, { ...DEFAULT_BOARD_LABELS, merged: 'Shipped', qaIssues: 'Bugs Found' });
  assert.equal(r.verdict, 'escaped');
  assert.equal(r.rounds.length, 1);
});

test('the rate is withheld until enough tickets have settled', () => {
  const rec = (verdict: EscapeRecord['verdict']): EscapeRecord =>
    ({ verdict, openedAt: 1, closedAt: 2, rounds: [], signOffWithdrawn: false });

  const thin = escapeRate([rec('escaped'), rec('clean')]);
  assert.equal(thin.rate, null, 'two tickets must not produce a percentage');
  assert.equal(thin.settled, 2);

  const enough = escapeRate([
    ...Array.from({ length: MIN_FOR_RATE - 3 }, () => rec('clean')),
    rec('escaped'), rec('escaped'), rec('escaped'),
    rec('open'), rec('not-shipped'),
  ]);
  assert.equal(enough.settled, MIN_FOR_RATE);
  assert.equal(enough.escaped, 3);
  assert.equal(enough.open, 1, 'open tickets are reported but not rated');
  assert.equal(enough.rate, 3 / MIN_FOR_RATE);
});

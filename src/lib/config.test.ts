import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredLabels } from './config.js';

type Labels = Parameters<typeof requiredLabels>[0];
type Phase = Parameters<typeof requiredLabels>[1][number];

const labels = (over: Partial<Labels> = {}): Labels => ({
  entry: 'Loop', entryId: 1, exit: 'merged', exitId: null,
  blocked: 'Needs Human', blockedId: 2, review: 'Review',
  testcaseReview: 'TestCase Review', designReview: '', notABug: 'Not a Bug',
  inReview: 'In Review', ...over,
} as Labels);

const phase = (name: string, labelSkills?: Record<string, string>): Phase => ({ name, labelSkills });

const names = (l: ReturnType<typeof requiredLabels>): string[] => l.map((x) => x.name);

test('a label a phase routes a skill on is required', () => {
  // The one that fails silently: an unmatched key just never routes, so the
  // phase runs without the method it was configured to have.
  const got = requiredLabels(labels(), [phase('plan', { Accessibility: 'frontend-accessibility' })], true);
  assert.ok(names(got).includes('Accessibility'));
  assert.equal(got.find((l) => l.name === 'Accessibility')?.why,
    "routes 'frontend-accessibility' to plan");
});

test('an unset optional gate is not a label', () => {
  // designReview is '' in the shipped config: the gate is off, and requiring a
  // label named '' would fail every project forever.
  assert.ok(!names(requiredLabels(labels(), [], true)).includes(''));
});

test('notABug is required only while reproduction is on', () => {
  assert.ok(names(requiredLabels(labels(), [], true)).includes('Not a Bug'));
  assert.ok(!names(requiredLabels(labels(), [], false)).includes('Not a Bug'));
});

test('the pipeline labels are always required', () => {
  const got = names(requiredLabels(labels(), [], false));
  for (const l of ['Loop', 'merged', 'Needs Human', 'Review', 'TestCase Review', 'In Review']) {
    assert.ok(got.includes(l), `${l} is checked`);
  }
});

test('one label used twice is reported once, by its first reason', () => {
  const got = requiredLabels(labels({ review: 'Loop' }), [], false);
  assert.equal(got.filter((l) => l.name === 'Loop').length, 1);
  assert.match(got.find((l) => l.name === 'Loop')!.why, /^entry/);
});

test('a phase with no labelSkills contributes nothing', () => {
  assert.deepEqual(
    names(requiredLabels(labels(), [phase('implement')], false)),
    names(requiredLabels(labels(), [], false)),
  );
});

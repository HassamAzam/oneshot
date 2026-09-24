import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consensus, judgePrompt, normaliseScorecard, points, skillsInvoked, transcriptResult,
  type EvalSet, type Scorecard, type Verdict,
} from './score.js';

const evals: EvalSet = {
  iid: 7, title: 'x',
  items: [
    { id: '7-1', gap: 'opacity', expect: 'moves the dot out of the faded parent' },
    { id: '7-2', gap: 'surface', expect: 'measures on the real surface' },
    { id: '7-3', gap: 'snaps', expect: 'counts six snapshots' },
  ],
};

test('transcriptResult reads the last result frame, not an earlier assistant line', () => {
  const jsonl = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
    'not json',
    JSON.stringify({ type: 'result', subtype: 'success', num_turns: 30, total_cost_usd: 2.5, structured_output: { summary: 's' } }),
    '',
  ].join('\n');
  assert.deepEqual(transcriptResult(jsonl), { output: { summary: 's' }, turns: 30, costUsd: 2.5 });
  assert.deepEqual(transcriptResult('{"type":"assistant"}'), { output: null, turns: 0, costUsd: 0 });
});

test('skillsInvoked lists each launched skill once, in launch order', () => {
  const jsonl = '{"tool_use_result":{"success":true,"commandName":"planning-methodology"}}\n'
    + '{"tool_use_result":{"success":true,"commandName":"frontend-accessibility"}}\n'
    + '{"tool_use_result":{"success":true,"commandName":"planning-methodology"}}';
  assert.deepEqual(skillsInvoked(jsonl), ['planning-methodology', 'frontend-accessibility']);
});

test('a verdict the judge skipped counts as missed, and order follows the checklist', () => {
  const card = normaliseScorecard(evals, {
    items: [
      { id: '7-2', verdict: 'partial', evidence: 'steps[1]' },
      { id: '7-1', verdict: 'caught', evidence: 'approach' },
      { id: 'bogus', verdict: 'caught', evidence: '' },
    ],
    notes: 'n',
  });
  assert.deepEqual(card.items.map((i) => [i.id, i.verdict]), [['7-1', 'caught'], ['7-2', 'partial'], ['7-3', 'missed']]);
  assert.deepEqual(points(card), { points: 1.5, max: 3 });
});

test('the judge prompt carries every checklist item and the plan itself', () => {
  const p = judgePrompt(evals, { summary: 'move the dot' });
  for (const i of evals.items) assert.match(p, new RegExp(`### ${i.id}`));
  assert.match(p, /"summary": "move the dot"/);
});

// ------------------------------------------------- agreeing with itself

/**
 * Judging the same plan three times gave 5.5, 4.0 and 4.5 out of 8 — and every
 * point of that spread came from two items, both of which offer the judge a
 * second way to score caught. The other six were identical all three times. So
 * the instability is a property of particular items, and a single run cannot
 * tell a stable verdict from a coin flip. consensus() reports both.
 */
const card = (...verdicts: Verdict[]): Scorecard => ({
  items: verdicts.map((v, n) => ({ id: `t-${n + 1}`, verdict: v, evidence: `e${n}` })),
  notes: '',
});

test('an item every run agreed on is reported at full agreement', () => {
  const c = consensus([card('caught'), card('caught'), card('caught')]);

  assert.equal(c.items[0]!.verdict, 'caught');
  assert.equal(c.items[0]!.agreement, 3);
  assert.equal(c.items[0]!.runs, 3);
  assert.deepEqual(c.items[0]!.dissent, []);
});

test('a split item takes the majority, and records what the others said', () => {
  const c = consensus([card('missed'), card('caught'), card('missed')]);

  assert.equal(c.items[0]!.verdict, 'missed');
  assert.equal(c.items[0]!.agreement, 2);
  assert.deepEqual(c.items[0]!.dissent, ['caught']);
});

test('a three-way split resolves to the worst verdict, never the flattering one', () => {
  // Nothing breaks a tie on the evidence, so it breaks toward not claiming credit.
  const c = consensus([card('caught'), card('partial'), card('missed')]);

  assert.equal(c.items[0]!.verdict, 'missed');
  assert.equal(c.items[0]!.agreement, 1);
});

test('the spread across runs is reported, because its width is the real result', () => {
  const c = consensus([
    card('caught', 'caught'), // 2.0
    card('caught', 'missed'), // 1.0
    card('caught', 'partial'), // 1.5
  ]);

  assert.equal(c.runs, 3);
  assert.deepEqual(c.scores, [2, 1, 1.5]);
  assert.equal(c.spread, 1);
  assert.equal(c.mean, 1.5);
});

test('a single run still works, and claims agreement of one rather than certainty', () => {
  const c = consensus([card('caught')]);

  assert.equal(c.items[0]!.agreement, 1);
  assert.equal(c.spread, 0);
});

test('consensus refuses an empty set rather than inventing a score of zero', () => {
  assert.throws(() => consensus([]), /at least one/i);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgePrompt, normaliseScorecard, points, skillsInvoked, transcriptResult, type EvalSet,
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

/**
 * rankFailureModes groups per-item failures into modes and orders them
 * worst-first; formatFailureModes renders that ranking, capping the locations
 * listed per mode. Together they turn a scatter of failures into a diagnosis.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankFailureModes, formatFailureModes, type FailureItem } from './failuremodes.js';

const item = (mode: string, severity: FailureItem['severity'], where: string): FailureItem => (
  { mode, label: mode, severity, where }
);

test('empty in, empty out', () => {
  assert.deepEqual(rankFailureModes([]), []);
  assert.deepEqual(formatFailureModes([]), []);
});

test('groups by mode and counts each', () => {
  const modes = rankFailureModes([
    item('a', 'high', 'x#1 c1'),
    item('a', 'high', 'x#1 c2'),
    item('b', 'high', 'x#2 c3'),
  ]);
  assert.equal(modes.length, 2);
  assert.equal(modes.find((m) => m.mode === 'a')!.count, 2);
  assert.equal(modes.find((m) => m.mode === 'b')!.count, 1);
});

test('higher severity ranks first, regardless of count', () => {
  const modes = rankFailureModes([
    item('frequent', 'medium', 'a'),
    item('frequent', 'medium', 'b'),
    item('frequent', 'medium', 'c'),
    item('rare', 'critical', 'd'),
  ]);
  assert.equal(modes[0]!.mode, 'rare');
  assert.equal(modes[1]!.mode, 'frequent');
});

test('within a severity, the more frequent mode ranks first', () => {
  const modes = rankFailureModes([
    item('one', 'high', 'a'),
    item('two', 'high', 'b'),
    item('two', 'high', 'c'),
  ]);
  assert.equal(modes[0]!.mode, 'two');
});

test('format caps locations per mode with a +N more tail', () => {
  const items = Array.from({ length: 9 }, (_, i) => item('m', 'high', `t#${i}`));
  const lines = formatFailureModes(rankFailureModes(items), { max: 6 });
  const row = lines.find((l) => l.includes('(9)'))!;
  assert.match(row, /\+3 more/);
});

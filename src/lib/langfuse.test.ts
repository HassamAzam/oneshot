import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSpans, type ExportedRun, type UsageRow } from './langfuse.js';
import type { PhaseRecord } from './artifacts.js';

interface Span {
  spanId: string;
  name: string;
  attributes: Array<{ key: string; value: { intValue?: string } }>;
}

const lap = (phase: string, n: number, startedAt: number, endedAt: number, status: PhaseRecord['status'] = 'ok'): PhaseRecord =>
  ({ phase, lap: n, status, startedAt, endedAt });

const run = (phases: PhaseRecord[]): ExportedRun => ({
  runId: 'r-test', iid: 1, title: 't', status: 'running', createdAt: 0, phases,
});

const usage = (phase: string, ts: number, input: number): UsageRow =>
  ({ phase, ts, input, output: 0, cacheRead: 0, cacheWrite: 0 });

const spanNamed = (spans: unknown[], name: string): Span => {
  const found = (spans as Span[]).find((s) => s.name === name);
  assert.ok(found, `no span named ${name}`);
  return found;
};

const inputTokens = (span: Span): number | undefined => {
  const v = span.attributes.find((a) => a.key === 'gen_ai.usage.input_tokens')?.value.intValue;
  return v === undefined ? undefined : Number(v);
};

test('a phase keeps its span id when failed laps before it are pruned from the journal', () => {
  const recall = lap('recall', 0, 100, 200);
  const remediate = lap('remediate', 0, 900, 1000);
  const before = run([recall, lap('mr', 1, 300, 400, 'failed'), lap('mr', 2, 500, 600, 'failed'), remediate]);
  const after = run([recall, remediate]);

  assert.equal(
    spanNamed(runSpans(after, [], 'anthropic'), 'remediate').spanId,
    spanNamed(runSpans(before, [], 'anthropic'), 'remediate').spanId,
  );
});

test('each lap of a phase carries only the tokens recorded while it ran', () => {
  const spans = runSpans(
    run([lap('mr', 1, 1000, 2000), lap('mr', 2, 3000, 4000)]),
    [usage('mr', 1500, 10), usage('mr', 3500, 7)],
    'anthropic',
  );

  assert.equal(inputTokens(spanNamed(spans, 'mr (lap 1)')), 10);
  assert.equal(inputTokens(spanNamed(spans, 'mr (lap 2)')), 7);
});

test('usage from a lap no longer in the journal is credited to no surviving lap', () => {
  const spans = runSpans(
    run([lap('mr', 1, 1000, 2000), lap('mr', 3, 5000, 6000)]),
    [usage('mr', 3500, 99), usage('mr', 5500, 4)],
    'anthropic',
  );

  assert.equal(inputTokens(spanNamed(spans, 'mr (lap 1)')), undefined);
  assert.equal(inputTokens(spanNamed(spans, 'mr (lap 3)')), 4);
});

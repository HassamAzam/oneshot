import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUTPUT_CAP, finalResultText, runSpans, type ExportedRun, type UsageRow } from './langfuse.js';
import type { PhaseRecord } from './artifacts.js';

interface Span {
  spanId: string;
  name: string;
  attributes: Array<{ key: string; value: { intValue?: string; stringValue?: string } }>;
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

const stringAttr = (span: Span, key: string): string | undefined =>
  span.attributes.find((a) => a.key === key)?.value.stringValue;

test('a lap span carries its final output text as the Langfuse output, and never an input', () => {
  const spans = runSpans(
    run([lap('mr', 1, 1000, 2000), lap('mr-open', 0, 2000, 2100)]),
    [],
    'anthropic',
    (p) => (p.phase === 'mr' ? 'MR !42 opened' : undefined),
  );

  assert.equal(stringAttr(spanNamed(spans, 'mr (lap 1)'), 'langfuse.observation.output'), 'MR !42 opened');
  assert.equal(stringAttr(spanNamed(spans, 'mr-open'), 'langfuse.observation.output'), undefined);
  for (const span of spans as Span[]) {
    assert.equal(stringAttr(span, 'langfuse.observation.input'), undefined);
  }
});

test('an output longer than the cap is cut to the cap', () => {
  const spans = runSpans(run([lap('plan', 0, 1000, 2000)]), [], 'anthropic', () => 'x'.repeat(OUTPUT_CAP + 50));

  assert.equal(stringAttr(spanNamed(spans, 'plan'), 'langfuse.observation.output')?.length, OUTPUT_CAP);
});

const withTranscript = (lines: unknown[], check: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'langfuse-test-'));
  try {
    const path = join(dir, 'mr-lap1.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
    check(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the final result text is read from the first result frame of a transcript', () => {
  withTranscript([
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } },
    { type: 'result', subtype: 'success', result: 'MR !42 opened' },
    { type: 'result', subtype: 'error_during_execution', errors: ['late'] },
  ], (path) => assert.equal(finalResultText(path), 'MR !42 opened'));
});

test('a transcript with no result frame yields no output text', () => {
  withTranscript([{ type: 'system', subtype: 'init' }], (path) => assert.equal(finalResultText(path), undefined));
});

test('a missing transcript yields no output text', () => {
  assert.equal(finalResultText(join(tmpdir(), 'langfuse-test-missing', 'none.jsonl')), undefined);
});

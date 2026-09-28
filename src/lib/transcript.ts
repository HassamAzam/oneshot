/**
 * Reading back what a phase session actually did, from the transcript it left.
 *
 * A phase writes two things: the artifact its schema describes, and the raw
 * session transcript beside it (`transcriptPath` in artifacts.ts). The artifact
 * is what the pipeline consumes. The transcript is the only record of what the
 * run COST to produce — turns, dollars, and which skills the session chose to
 * launch as opposed to which ones it was handed.
 *
 * That distinction is the reason this exists. A phase's configured skill list
 * says what should have loaded; only the transcript says what did, and the two
 * have disagreed often enough that the difference is worth reading rather than
 * assuming.
 */
import { readFileSync } from 'node:fs';

/**
 * A phase transcript's own result frame: the structured output, turns and cost.
 *
 * Read from the END backwards: a session emits assistant frames throughout and
 * exactly one `result` at the close, and an earlier frame that happens to parse
 * is not the answer. The transcript is also the only place an ORIGINAL lap-0
 * artifact survives — the artifact file itself is overwritten by every later
 * lap, including ones a reviewer's feedback steered.
 *
 * Returns zeroes rather than throwing when there is no result frame: a session
 * killed mid-flight leaves a transcript worth reading for everything else in
 * it, and a parse failure here should not be the thing that ends a caller.
 */
export function transcriptResult(jsonl: string): {
  output: Record<string, unknown> | null; turns: number; costUsd: number;
} {
  const lines = jsonl.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(lines[i]!) as Record<string, unknown>; } catch { continue; }
    if (frame.type !== 'result') continue;
    return {
      output: (frame.structured_output as Record<string, unknown> | undefined) ?? null,
      turns: Number(frame.num_turns ?? 0),
      costUsd: Number(frame.total_cost_usd ?? 0),
    };
  }
  return { output: null, turns: 0, costUsd: 0 };
}

/**
 * Skills the session actually launched, in launch order.
 *
 * Configured is not loaded. A phase naming five skills has been observed
 * launching two, and the artifact gives no sign of it — the plan simply reads
 * as though the missing method was never part of the job.
 */
export function skillsInvoked(jsonl: string): string[] {
  const out: string[] = [];
  for (const m of jsonl.matchAll(/"commandName":"([^"]+)"/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** An artifact, from its own JSON file or from the result frame of a transcript. */
export function loadArtifact(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    const { output } = transcriptResult(text);
    if (!output) throw new Error(`${path} has no structured result — the session never finished`);
    return output;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

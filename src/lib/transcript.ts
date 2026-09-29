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
 * The FIRST result frame, not the last — a session can emit several. Observed
 * live: a `success` frame carrying the real turn count and usage, followed by
 * an `error_during_execution` frame carrying zero of both. src/conductor/
 * phase.ts settles a live phase on the first frame for that reason and leaves
 * the rest in the tee; a reader that takes the last one disagrees with the
 * conductor about what the same session did, and records a plan that cost real
 * money as free. Assistant frames are skipped by type, not by position, so
 * scanning forward costs nothing.
 *
 * The transcript is also the only place an ORIGINAL lap-0 artifact survives —
 * the artifact file itself is overwritten by every later lap, including ones a
 * reviewer's feedback steered.
 *
 * Returns zeroes rather than throwing when there is no result frame: a session
 * killed mid-flight leaves a transcript worth reading for everything else in
 * it, and a parse failure here should not be the thing that ends a caller.
 */
export function transcriptResult(jsonl: string): {
  output: Record<string, unknown> | null; turns: number; costUsd: number;
} {
  const lines = jsonl.split('\n').filter(Boolean);
  for (const line of lines) {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
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

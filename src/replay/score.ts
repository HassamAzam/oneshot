/**
 * Scoring a replayed plan against a hand-audited checklist.
 *
 * Pure on purpose: scripts/replay-plan.ts has to set DRY_RUN and the skills
 * root before config.ts is ever imported, so nothing here may import it.
 *
 * The checklist (evals/plan/<iid>.json) is a list of gaps a human found in an
 * earlier run's plan — facts a good plan states UNAIDED. A replay is worth
 * running only if its score can be compared with the run it replays, so the
 * same judge scores the original plan (`--score`) and each replay.
 */
import { readFileSync } from 'node:fs';

export interface EvalItem { id: string; gap: string; expect: string }
export interface EvalSet { iid: number; title: string; baseSha?: string; items: EvalItem[] }

export type Verdict = 'caught' | 'partial' | 'missed';
export interface ItemScore { id: string; verdict: Verdict; evidence: string }
export interface Scorecard { items: ItemScore[]; notes: string }

export const SCORECARD_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['caught', 'partial', 'missed'] },
          evidence: { type: 'string' },
        },
        required: ['id', 'verdict', 'evidence'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['items', 'notes'],
} as const;

const POINTS: Record<Verdict, number> = { caught: 1, partial: 0.5, missed: 0 };

/**
 * A phase transcript's own result: the structured output, turns and cost.
 *
 * The transcript is the only place the ORIGINAL lap-0 plan survives — plan.json
 * is overwritten by every later lap, including the ones feedback steered.
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

/** Skills the session actually launched, in order — configured is not loaded. */
export function skillsInvoked(jsonl: string): string[] {
  const out: string[] = [];
  for (const m of jsonl.matchAll(/"commandName":"([^"]+)"/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** A plan from a plan.json artifact, or from the result frame of a phase transcript. */
export function loadPlan(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    const { output } = transcriptResult(text);
    if (!output) throw new Error(`${path} has no structured result — the session never finished`);
    return output;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export function judgePrompt(evals: EvalSet, plan: Record<string, unknown>): string {
  return `You are scoring an implementation plan for ticket #${evals.iid} (${evals.title}) against a
checklist of gaps a senior engineer found by auditing an earlier plan for the same ticket.

Score each checklist item:
- caught  — the plan itself states the point (or an equivalent that would lead an implementer to
            the same correct outcome), specifically enough to act on.
- partial — the plan gestures at it (names the file, lists the concern generically, gets half of
            a multi-part item) but an implementer could still get it wrong.
- missed  — absent, or the plan states the opposite / a wrong fact.

Rules:
- Judge ONLY what is written in the plan below. Do not credit what the planner may have known.
- An item's own text may define its partial/missed thresholds; follow it.
- \`evidence\` quotes the plan (a short excerpt with its field, e.g. steps[2].detail) for caught
  or partial, and says what is missing or wrong for missed.
- Return exactly one entry per checklist id, in checklist order. \`notes\` is one or two sentences
  on anything the plan got wrong that the checklist does not cover.

## Checklist
${evals.items.map((i) => `### ${i.id} — ${i.gap}\n${i.expect}`).join('\n\n')}

## Plan
${JSON.stringify(plan, null, 2)}`;
}

/** Keep one verdict per checklist id, in checklist order; an id the judge skipped is missed. */
export function normaliseScorecard(evals: EvalSet, raw: Partial<Scorecard> | null): Scorecard {
  const byId = new Map((raw?.items ?? []).map((i) => [i.id, i]));
  return {
    items: evals.items.map((i) => byId.get(i.id)
      ?? { id: i.id, verdict: 'missed' as const, evidence: '(the judge returned no verdict for this item)' }),
    notes: raw?.notes ?? '',
  };
}

export function points(card: Scorecard): { points: number; max: number } {
  return {
    points: card.items.reduce((s, i) => s + (POINTS[i.verdict] ?? 0), 0),
    max: card.items.length,
  };
}

export function scoreTable(evals: EvalSet, card: Scorecard): string {
  const gap = new Map(evals.items.map((i) => [i.id, i.gap]));
  const { points: p, max } = points(card);
  const rows = card.items.map((i) => `  ${i.verdict.padEnd(7)} ${i.id.padEnd(6)} ${gap.get(i.id) ?? ''}`);
  return `${rows.join('\n')}\n  score   ${p}/${max}`;
}

/** One checklist item's verdict across repeated judgements of the same plan. */
export interface ConsensusItem extends ItemScore {
  /** How many runs returned the verdict above. */
  agreement: number;
  /** How many runs there were, so agreement reads as a fraction without arithmetic. */
  runs: number;
  /** The verdicts the other runs gave, each listed once. */
  dissent: Verdict[];
}

export interface Consensus {
  items: ConsensusItem[];
  runs: number;
  /** Each run's total, in the order judged. */
  scores: number[];
  mean: number;
  /** Highest total minus lowest. The number that says whether a result is a result. */
  spread: number;
  max: number;
}

/** Worst first: a tie is broken toward not claiming credit. */
const SEVERITY: Verdict[] = ['missed', 'partial', 'caught'];

/**
 * Judge the same plan N times and report what survived repetition.
 *
 * A single judgement cannot tell a verdict the evidence forces from one the
 * judge could have gone either way on, and those are not rare: scored three
 * times, the same plan came back 5.5, 4.0 and 4.5 out of 8. Every point of that
 * spread sat in two items that offer a second route to `caught`; the other six
 * were identical every time. Reporting only a total hides which kind of item
 * produced it.
 *
 * So the per-item verdict is the majority one, ties broken toward the worst
 * rather than the most flattering, and `agreement` travels with it. `spread` is
 * the honest headline: where it is wider than the effect being measured, no
 * number of reps makes that comparison mean anything, and the checklist is what
 * needs fixing rather than the sample size.
 */
export function consensus(cards: Scorecard[]): Consensus {
  if (!cards.length) throw new Error('consensus needs at least one scorecard');
  const first = cards[0]!;
  const items: ConsensusItem[] = first.items.map((item, n) => {
    const verdicts = cards.map((c) => c.items[n]?.verdict ?? 'missed');
    const tally = new Map<Verdict, number>();
    for (const v of verdicts) tally.set(v, (tally.get(v) ?? 0) + 1);
    const winner = [...tally.entries()].sort(
      (a, b) => b[1] - a[1] || SEVERITY.indexOf(a[0]) - SEVERITY.indexOf(b[0]),
    )[0]!;
    return {
      id: item.id,
      verdict: winner[0],
      // The evidence from a run that agreed with the consensus, so the quote
      // shown is one that supports the verdict printed beside it.
      evidence: cards.find((c) => c.items[n]?.verdict === winner[0])?.items[n]?.evidence ?? '',
      agreement: winner[1],
      runs: cards.length,
      dissent: [...tally.keys()].filter((v) => v !== winner[0]),
    };
  });
  const scores = cards.map((c) => points(c).points);
  return {
    items,
    runs: cards.length,
    scores,
    mean: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
    spread: Math.max(...scores) - Math.min(...scores),
    max: first.items.length,
  };
}

/** The consensus table: verdict, agreement, and the spread that qualifies it. */
export function consensusTable(evals: EvalSet, c: Consensus): string {
  const gap = new Map(evals.items.map((i) => [i.id, i.gap]));
  const rows = c.items.map((i) => {
    const split = i.dissent.length ? `  (also ${i.dissent.join(', ')})` : '';
    return `  ${i.verdict.padEnd(7)} ${i.id.padEnd(6)} ${(gap.get(i.id) ?? '').padEnd(52)}`
      + ` ${i.agreement}/${i.runs}${split}`;
  });
  const consensusPoints = c.items.reduce((s, i) => s + (POINTS[i.verdict] ?? 0), 0);
  return `${rows.join('\n')}\n`
    + `  score   ${consensusPoints}/${c.max} by consensus of ${c.runs}`
    + `  ·  runs ${c.scores.join(', ')}  ·  mean ${c.mean}  ·  spread ${c.spread}`;
}

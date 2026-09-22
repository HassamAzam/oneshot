/**
 * `npm run score -- <iid> <plan.json|plan-lapN.jsonl>` — grade a plan that
 * already exists against the hand-audited checklist for its ticket.
 *
 * Judging an artifact and REPLAYING a phase are different jobs with different
 * costs, and only the second needs a worktree, a base sha, a skills root and a
 * model session that writes a new plan. This does the first: it reads a plan
 * off disk, asks the judge, and prints the table. Nothing is run, nothing is
 * written except the scorecard beside its input.
 *
 * That separation is what lets the scoring half live here while the replay
 * driver stays on its own branch: src/replay/score.ts imports nothing but
 * node:fs, so the only things this file needs from the repo are the model
 * table and the SDK.
 *
 * The checklist is evals/plan/<iid>.json — gaps a senior engineer found by
 * auditing an earlier plan, each one a fact a good plan states unaided. A score
 * is only meaningful next to another score for the same ticket, so run this on
 * the artifact you are comparing against before you change anything.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgePrompt, loadPlan, normaliseScorecard, points, SCORECARD_SCHEMA, scoreTable,
  type EvalSet, type Scorecard,
} from '../src/replay/score.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = 'usage: npm run score -- <iid> <plan.json|plan-lapN.jsonl> [--judge-tier standard|heavy]';

interface Args { iid: number; plan: string; judgeTier: 'standard' | 'heavy' }

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { judgeTier: 'heavy' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--judge-tier') {
      const v = argv[++i];
      if (v !== 'standard' && v !== 'heavy') throw new Error(`--judge-tier is standard or heavy\n${USAGE}`);
      a.judgeTier = v;
    } else if (/^\d+$/.test(arg) && a.iid === undefined) a.iid = Number(arg);
    else a.plan = resolve(arg);
  }
  if (a.iid === undefined || !a.plan) throw new Error(USAGE);
  if (!existsSync(a.plan)) throw new Error(`no such plan: ${a.plan}`);
  return a as Args;
}

const args = parseArgs(process.argv.slice(2));

// Before ANY import that reaches src/lib/config.ts — it is read once, at load.
// Judging must never be able to act on a ticket, whatever else is configured.
process.env.DRY_RUN = '1';

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { modelFor } = await import('../src/lib/config.js');

const evalsPath = join(ROOT, 'evals', 'plan', `${args.iid}.json`);
if (!existsSync(evalsPath)) {
  console.error(`no checklist at ${evalsPath} — nothing to score against`);
  process.exit(1);
}
const evals = JSON.parse(readFileSync(evalsPath, 'utf8')) as EvalSet;

const model = modelFor({ name: 'plan-judge', tier: args.judgeTier } as never);
const q = query({
  prompt: judgePrompt(evals, loadPlan(args.plan)),
  options: {
    model, maxTurns: 4, tools: [], settingSources: [], cwd: ROOT,
    outputFormat: { type: 'json_schema', schema: SCORECARD_SCHEMA as never },
  } as never,
});

let raw: Partial<Scorecard> | null = null;
for await (const m of q as AsyncIterable<Record<string, unknown>>) {
  if (m.type === 'result') raw = (m.structured_output as Partial<Scorecard> | undefined) ?? null;
}
if (!raw) throw new Error('the judge returned no scorecard');

const card = normaliseScorecard(evals, raw);
console.log(`#${args.iid} ${args.plan}\n${scoreTable(evals, card)}`);

const suffix = args.judgeTier === 'heavy' ? '' : `.${args.judgeTier}`;
const out = args.plan.replace(/\.(jsonl|json)$/, `.score${suffix}.json`);
writeFileSync(out, `${JSON.stringify({ ...card, points: points(card) }, null, 2)}\n`);
console.log(`scorecard: ${out}`);

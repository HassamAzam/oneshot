/**
 * Missing edge cases: for each ticket in evals/edge-coverage/gold.json, does
 * the test list its run holds now contain a case for every edge a good list
 * must have?
 *
 *   npm run eval:edges            # every gold ticket
 *   npm run eval:edges -- <iid> <iid>  # just these
 *
 * Case wording never matches an edge's wording, so a judge model decides which
 * case, if any, exercises each edge. It gets no tools and sees only the edges
 * and the cases, and it is told to answer "none" unless a case's steps and
 * expected result would actually catch that edge failing: a case that merely
 * mentions the same screen does not cover it.
 *
 * The score is edges covered / edges. Edges with source "bug" matter most: a
 * list missing one of those let a real defect through. Re-run the testcases
 * phase on a gold ticket after changing its prompt, then run this, to see
 * whether the change made test lists weaker.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BASE_ENV, ROOT, STATE } from '../src/lib/config.js';

interface Edge { id: string; source: 'bug' | 'ticket'; edge: string }
interface GoldFile { project: string; tickets: Record<string, Edge[]> }
interface Case { id: string; scenario: string; precondition: string; steps: string[]; expected: string }
interface Verdict { edge: string; coveredBy: string; reason: string }

const GOLD = join(ROOT, 'evals', 'edge-coverage', 'gold.json');
const IPV4_SHIM = join(ROOT, 'scripts', 'ipv4-dns.cjs');
const JUDGE_TIER = 'standard';
const JUDGE_MAX_TURNS = 3;

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          edge: { type: 'string', description: 'Edge id, e.g. E1.' },
          coveredBy: { type: 'string', description: 'The id of the case that would catch this edge failing, or "none".' },
          reason: { type: 'string', description: 'One line: what in that case catches it, or what every case lacks.' },
        },
        required: ['edge', 'coveredBy', 'reason'],
      },
    },
  },
  required: ['verdicts'],
};

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function judgeModel(): string {
  const models = readJson<{ tiers: Record<string, string> }>(join(ROOT, 'config', 'models.json'));
  const model = models?.tiers[JUDGE_TIER];
  if (!model) throw new Error(`config/models.json has no '${JUDGE_TIER}' tier`);
  return model;
}

function judgePrompt(edges: Edge[], cases: Case[]): string {
  const caseText = cases.map((c) => [
    `${c.id}: ${c.scenario}`,
    `  precondition: ${c.precondition || '-'}`,
    `  steps: ${c.steps.join(' / ')}`,
    `  expected: ${c.expected}`,
  ].join('\n')).join('\n\n');
  return [
    'You grade a QA test list. For each required edge case below, name the ONE test case whose',
    'precondition, steps and expected result would fail if the software got that edge wrong.',
    'Answer "none" when no case would: a case that only visits the same screen, or checks the',
    'edge in a different state than the one described, does not cover it. Judge only from the',
    'text given. Answer for every edge id.',
    '',
    'REQUIRED EDGES',
    edges.map((e) => `${e.id}: ${e.edge}`).join('\n'),
    '',
    'TEST CASES',
    caseText,
  ].join('\n');
}

async function judge(edges: Edge[], cases: Case[], model: string): Promise<Verdict[]> {
  const q = query({
    prompt: judgePrompt(edges, cases),
    options: {
      model,
      env: { ...BASE_ENV },
      tools: [],
      maxTurns: JUDGE_MAX_TURNS,
      settingSources: [],
      systemPrompt: 'You are a strict QA reviewer. Reply only through the structured output.',
      outputFormat: { type: 'json_schema', schema: VERDICT_SCHEMA },
      ...(existsSync(IPV4_SHIM) ? { executableArgs: ['--require', IPV4_SHIM] } : {}),
    },
  });
  for await (const msg of q) {
    if (msg.type !== 'result') continue;
    if (msg.subtype !== 'success') throw new Error(`judge ended with ${msg.subtype}`);
    return (msg.structured_output as { verdicts: Verdict[] }).verdicts;
  }
  throw new Error('judge returned no result');
}

async function main(): Promise<void> {
  const gold = readJson<GoldFile>(GOLD);
  if (!gold) { console.error(`cannot read ${GOLD}`); process.exit(2); }
  const only = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
  const iids = Object.keys(gold.tickets).filter((iid) => !only.length || only.includes(iid));
  const model = judgeModel();
  const rows: Array<Record<string, string | number>> = [];
  const missing: string[] = [];
  let graded = 0;

  await Promise.all(iids.map(async (iid) => {
    const dir = join(STATE, 'runs', iid);
    const run = readJson<{ url: string; runId: string }>(join(dir, 'run.json'));
    const cases = readJson<{ cases: Case[] }>(join(dir, 'testcases.json'))?.cases;
    if (!run || !run.url.startsWith(gold.project) || !cases?.length) {
      console.log(`#${iid}: no test list on disk for this project, skipped`);
      return;
    }
    const edges = gold.tickets[iid] ?? [];
    graded += edges.length;
    const verdicts = new Map((await judge(edges, cases, model)).map((v) => [v.edge, v]));
    const uncovered = edges.filter((e) => {
      const by = verdicts.get(e.id)?.coveredBy ?? 'none';
      return by === 'none' || !cases.some((c) => c.id === by);
    });
    const bugEdges = edges.filter((e) => e.source === 'bug');
    for (const e of uncovered) {
      missing.push(`#${iid} ${e.id} [${e.source}] ${e.edge}\n      judge: ${verdicts.get(e.id)?.reason ?? 'no verdict'}`);
    }
    rows.push({
      iid: Number(iid),
      runId: run.runId,
      covered: `${edges.length - uncovered.length}/${edges.length}`,
      bugEdgesMissed: `${uncovered.filter((e) => e.source === 'bug').length}/${bugEdges.length}`,
    });
  }));

  rows.sort((a, b) => Number(a.iid) - Number(b.iid));
  console.table(rows);
  console.log(`judge: ${model}. ${missing.length} of ${graded} edges missing.`);
  for (const m of missing) console.log(`  ${m}`);
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });

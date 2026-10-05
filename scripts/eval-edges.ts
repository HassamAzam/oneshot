/**
 * Missing edge cases: for each ticket in evals/edge-coverage/gold.json, does
 * the test list its run holds now contain a case for every edge a good list
 * must have? Tickets are grouped by GitLab project, and a run on disk is
 * graded only when its URL is in that ticket's project.
 *
 *   npm run eval:edges                                   # grade the lists the runs hold on disk
 *   npm run eval:edges -- <iid> <iid>                    # just these
 *   npm run eval:edges -- --replay --label prompt-b      # re-run testcases with THIS checkout's prompt first
 *   npm run eval:edges -- --save --label prompt-a        # also commit the scores to evals/history/
 *   npm run eval:edges -- --vs prompt-a                  # compare against that saved scoring
 *
 * Case wording never matches an edge's wording, so a judge model decides which
 * case, if any, exercises each edge. It gets no tools and sees only the edges
 * and the cases, and it is told to answer "none" unless a case's steps and
 * expected result would actually catch that edge failing: a case that merely
 * mentions the same screen does not cover it.
 *
 * The score is edges covered / edges. Edges with source "bug" matter most: a
 * list missing one of those let a real defect through.
 *
 * Without --replay this grades the first list each run wrote, before any QA
 * feedback, with whatever prompt was live then, so a prompt change does not move it. --replay runs replay-testcases.ts
 * per ticket (a dry run on the inputs the first testcases session had) and
 * grades those lists instead. Every run prints the change against the newest
 * saved scoring, or the one --vs names, and flags each edge that was covered
 * there and is missing now.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BASE_ENV, ROOT, STATE } from '../src/lib/config.js';
import { transcriptResult } from '../src/lib/transcript.js';
import { argValue, loadHistory, saveHistory, type Saved } from './evalhistory.js';

interface Edge { id: string; source: 'bug' | 'ticket'; edge: string }
interface GoldFile { projects: Record<string, Record<string, Edge[]>> }
interface Case { id: string; scenario: string; precondition: string; steps: string[]; expected: string }
interface Verdict { edge: string; coveredBy: string; reason: string }

const GOLD = join(ROOT, 'evals', 'edge-coverage', 'gold.json');
const IPV4_SHIM = join(ROOT, 'scripts', 'ipv4-dns.cjs');
const JUDGE_TIER = 'standard';
const JUDGE_MAX_TURNS = 3;
const KIND = 'edge-coverage';

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

function repoName(project: string): string {
  return project.split('/').pop() ?? project;
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

interface TicketScore {
  repo: string; iid: number; covered: number; edges: number; bugCovered: number; bugEdges: number; missing: string[];
}
interface EdgeScores { judge: string; tickets: TicketScore[] }

const REPLAY_PARALLEL = 3;
const VALUE_FLAGS = new Set(['--label', '--vs']);

/** Run replay-testcases.ts for one ticket and return the case list it wrote, or null. */
function replay(iid: string, label: string): Promise<Case[] | null> {
  return new Promise((done) => {
    const child = spawn('npx', ['tsx', join(ROOT, 'scripts', 'replay-testcases.ts'), iid, '--label', label], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString(); });
    child.on('close', () => {
      const dir = /^OUTPUT (.+)$/m.exec(out)?.[1];
      const cases = dir ? readJson<{ cases: Case[] }>(join(dir, 'testcases.json'))?.cases ?? null : null;
      if (!cases) console.log(`#${iid}: replay produced no test list\n${out.trim().split('\n').slice(-5).map((l) => `      ${l}`).join('\n')}`);
      else console.log(`#${iid}: replayed, ${cases.length} cases in ${dir}`);
      done(cases);
    });
  });
}

async function pool<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

/**
 * The first list a live run's testcases phase wrote, before any QA feedback:
 * the first result in its lap 0 transcript. testcases.json holds the list after
 * every revision round, which a replay (no feedback) cannot be compared with.
 * Falls back to testcases.json, saying so, when the transcript is gone.
 */
function liveCases(project: string, iid: string): Case[] | null {
  const dir = join(STATE, 'runs', iid);
  const run = readJson<{ url: string }>(join(dir, 'run.json'));
  if (!run?.url.startsWith(`${project}/`)) return null;
  const tee = join(dir, 'transcripts', 'testcases-lap0.jsonl');
  const first = existsSync(tee) ? transcriptResult(readFileSync(tee, 'utf8')).output as { cases?: Case[] } | null : null;
  if (first?.cases?.length) return first.cases;
  console.log(`${repoName(project)}#${iid}: no lap 0 transcript, grading the final testcases.json instead`);
  return readJson<{ cases: Case[] }>(join(dir, 'testcases.json'))?.cases ?? null;
}

async function score(project: string, iid: string, edges: Edge[], cases: Case[], model: string): Promise<TicketScore> {
  const verdicts = new Map((await judge(edges, cases, model)).map((v) => [v.edge, v]));
  const uncovered = edges.filter((e) => {
    const by = verdicts.get(e.id)?.coveredBy ?? 'none';
    return by === 'none' || !cases.some((c) => c.id === by);
  });
  for (const e of uncovered) {
    console.log(`  ${repoName(project)}#${iid} ${e.id} [${e.source}] missing: ${e.edge}\n      judge: ${verdicts.get(e.id)?.reason ?? 'no verdict'}`);
  }
  const bugEdges = edges.filter((e) => e.source === 'bug').length;
  return {
    repo: repoName(project), iid: Number(iid), covered: edges.length - uncovered.length, edges: edges.length,
    bugCovered: bugEdges - uncovered.filter((e) => e.source === 'bug').length, bugEdges,
    missing: uncovered.map((e) => e.id),
  };
}

function totals(tickets: TicketScore[]): { covered: number; edges: number; bugCovered: number; bugEdges: number } {
  const sum = (k: 'covered' | 'edges' | 'bugCovered' | 'bugEdges'): number => tickets.reduce((a, t) => a + t[k], 0);
  return { covered: sum('covered'), edges: sum('edges'), bugCovered: sum('bugCovered'), bugEdges: sum('bugEdges') };
}

function report(now: TicketScore[], base: Saved<EdgeScores> | null): void {
  const was = (t: TicketScore): TicketScore | undefined => base?.data.tickets.find((b) => b.repo === t.repo && b.iid === t.iid);
  console.table(now.map((t) => ({
    repo: t.repo, iid: t.iid,
    covered: `${t.covered}/${t.edges}`, bugCovered: `${t.bugCovered}/${t.bugEdges}`,
    ...(base ? { [`was (${base.label})`]: was(t) ? `${was(t)!.covered}/${was(t)!.edges}, bug ${was(t)!.bugCovered}/${was(t)!.bugEdges}` : '—' } : {}),
  })));
  const n = totals(now);
  console.log(`now:  ${n.covered}/${n.edges} edges, ${n.bugCovered}/${n.bugEdges} bug edges`);
  if (!base) return;
  const both = now.filter(was);
  const b = totals(both.map((t) => was(t)!));
  const m = totals(both);
  console.log(`was:  ${b.covered}/${b.edges} edges, ${b.bugCovered}/${b.bugEdges} bug edges   `
    + `(${base.label}, ${base.mode}, oneshot ${base.oneshot}, ${base.at.slice(0, 10)}; over the ${both.length} ticket(s) both scored)`);
  console.log(`then→now on those: edges ${b.covered}→${m.covered}, bug edges ${b.bugCovered}→${m.bugCovered}`);
  for (const t of both) {
    const lost = t.missing.filter((id) => !was(t)!.missing.includes(id));
    if (lost.length) console.log(`  REGRESSED ${t.repo}#${t.iid}: ${lost.join(', ')} covered before, missing now`);
  }
}

async function main(): Promise<void> {
  const gold = readJson<GoldFile>(GOLD);
  if (!gold) { console.error(`cannot read ${GOLD}`); process.exit(2); }
  const argv = process.argv.slice(2);
  const replaying = argv.includes('--replay');
  const label = argValue(argv, '--label');
  if (argv.includes('--save') && !label) { console.error('--save needs --label <name>, e.g. --label prompt-a'); process.exit(2); }
  const only = argv.filter((a, i) => /^\d+$/.test(a) && !VALUE_FLAGS.has(argv[i - 1] ?? ''));
  const targets = Object.entries(gold.projects)
    .flatMap(([project, tickets]) => Object.entries(tickets).map(([iid, edges]) => ({ project, iid, edges })))
    .filter(({ iid }) => !only.length || only.includes(iid));
  const iids = targets.map((t) => t.iid);
  const width = new Set(iids).size === iids.length ? REPLAY_PARALLEL : 1;
  const model = judgeModel();

  const lists = replaying
    ? await pool(targets.map((t) => () => replay(t.iid, label ?? 'eval')), width)
    : targets.map((t) => liveCases(t.project, t.iid));
  const scored = await Promise.all(targets.map(async (t, i) => {
    const cases = lists[i];
    if (!cases?.length) {
      console.log(`${repoName(t.project)}#${t.iid}: no test list to grade, skipped`);
      return null;
    }
    return score(t.project, t.iid, t.edges, cases, model);
  }));
  const tickets = scored.filter((t): t is TicketScore => t !== null)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.iid - b.iid);

  console.log(`\njudge: ${model}. graded ${replaying ? 'fresh replays of the current prompt' : "each run's first test list, before QA feedback"}.`);
  report(tickets, loadHistory<EdgeScores>(ROOT, KIND, argValue(argv, '--vs')));
  if (argv.includes('--save')) {
    console.log(`saved ${saveHistory(ROOT, KIND, label!, replaying ? 'replay' : 'live', { judge: model, tickets })}`);
  }
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });

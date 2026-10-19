/**
 * Missing edge cases: for each ticket in evals/edge-coverage/gold.json, does
 * the test list its run holds now contain a case for every edge a good list
 * must have? Tickets are grouped by GitLab project, and a run on disk is
 * graded only when its URL is in that ticket's project.
 *
 *   npm run eval:edges                                   # grade the lists the runs hold on disk
 *   npm run eval:edges -- <iid> <iid>                    # just these
 *   npm run eval:edges -- --repeat 5                     # judge each list 5x and report the spread
 *   npm run eval:edges -- --replay --label prompt-b      # re-run testcases with THIS checkout's prompt first
 *   npm run eval:edges -- --replay --repeat 5 --label b  # regenerate AND judge 5x per ticket
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
 * Measurement. One judge pass is a single noisy sample: the judge changes its
 * mind between identical runs, and under --replay the list itself is
 * regenerated each time. --repeat k takes k samples of the same ticket — it
 * re-judges the fixed list, or re-replays and re-judges under --replay — and
 * reports edges covered in every trial, edges that flip (flaky, the judge's
 * noise) and the spread between the best and worst trial. Run it once on an
 * unchanged config to learn that spread; a later --vs change counts as real
 * only when it clears it. Without --repeat, k is 1 and the output matches the
 * single-run behaviour exactly.
 *
 * Without --replay this grades the first list each run wrote, before any QA
 * feedback, with whatever prompt was live then, so a prompt change does not move it. --replay runs replay-testcases.ts
 * per ticket (a dry run on the inputs the first testcases session had) and
 * grades those lists instead. Every run prints the change against the newest
 * saved scoring, or the one --vs names, and flags each edge that was covered
 * there and is missing now.
 *
 * Before the judge runs, a cheap structural check drops any list with no
 * well-formed case (a case needs at least one step and an expected result that
 * asserts something): such a list covers no edge, so paying a judge to confirm
 * it wastes a call. Where a gold edge carries a `truth` of covered/none, the
 * run also reports how often the judge matched it — the judge's own error rate,
 * to weigh its unlabelled verdicts by.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BASE_ENV, ROOT, STATE } from '../src/lib/config.js';
import { transcriptResult } from '../src/lib/transcript.js';
import { tallyTrials, majorityCovered, beyondNoise, type RepeatStats } from '../src/lib/edgestats.js';
import { rankFailureModes, formatFailureModes, type FailureItem } from '../src/lib/failuremodes.js';
import { argValue, loadHistory, saveHistory, type Saved } from './evalhistory.js';

interface Edge { id: string; source: 'bug' | 'ticket'; edge: string; truth?: 'covered' | 'none' }
interface GoldFile { projects: Record<string, Record<string, Edge[]>> }
interface Case { id: string; scenario: string; precondition: string; steps: string[]; expected: string }
interface Verdict { edge: string; coveredBy: string; reason: string }
interface Target { project: string; iid: string; edges: Edge[] }

const GOLD = join(ROOT, 'evals', 'edge-coverage', 'gold.json');
const IPV4_SHIM = join(ROOT, 'scripts', 'ipv4-dns.cjs');
const JUDGE_TIER = 'standard';
const JUDGE_MAX_TURNS = 3;
const KIND = 'edge-coverage';

const VACUOUS_EXPECTED = /^(|-|n\/?a|tbd|works?|should work|passes?|ok|no error)\.?$/i;

/**
 * A case the judge can reason about at all: it has at least one step and an
 * expected result that asserts something. A list with no well-formed case is
 * not judged — an empty or placeholder list covers no edge, and paying a judge
 * to say so wastes a call.
 */
function wellFormed(c: Case): boolean {
  return c.steps.some((s) => s.trim()) && !VACUOUS_EXPECTED.test(c.expected.trim());
}

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

/** The edge ids one judge pass marked covered by a case that is actually in the list. */
function coveredSet(edges: Edge[], cases: Case[], verdicts: Map<string, Verdict>): Set<string> {
  return new Set(edges.filter((e) => {
    const by = verdicts.get(e.id)?.coveredBy ?? 'none';
    return by !== 'none' && cases.some((c) => c.id === by);
  }).map((e) => e.id));
}

interface TicketScore {
  repo: string; iid: number; covered: number; edges: number; bugCovered: number; bugEdges: number; missing: string[];
  wellFormed: number; cases: number;
  /** Edges whose gold truth is known, and how many the judge matched (by majority across trials). */
  truthChecked: number; truthAgreed: number;
  /** Repeat-run measurement: trials taken, edges that flipped, and the best–worst coverage band. */
  trials: number; flaky: string[]; spread: number; minCovered: number; maxCovered: number;
  /** Per-edge failures tagged by mode, for the ranked diagnosis. */
  diag: FailureItem[];
}
interface EdgeScores { judge: string; tickets: TicketScore[] }

const REPLAY_PARALLEL = 3;
const VALUE_FLAGS = new Set(['--label', '--vs', '--repeat']);

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

/** Build a ticket's score from the k trials' covered-sets, and print its per-edge diagnosis. */
function scoreTicket(t: Target, stats: RepeatStats, lastVerdicts: Map<string, Verdict>, wellFormedCount: number, caseCount: number): TicketScore {
  const repo = repoName(t.project);
  const edgeOf = new Map(t.edges.map((e) => [e.id, e]));
  const hitsOf = new Map(stats.perEdge.map((p) => [p.id, p.hits]));
  const reason = (id: string): string => lastVerdicts.get(id)?.reason ?? 'no verdict';
  const diag: FailureItem[] = [];
  for (const id of stats.missingEveryTrial) {
    const bug = edgeOf.get(id)?.source === 'bug';
    console.log(`  ${repo}#${t.iid} ${id} [${edgeOf.get(id)?.source}] missing${stats.trials > 1 ? ' in every trial' : ''}: ${edgeOf.get(id)?.edge}\n      judge: ${reason(id)}`);
    diag.push({
      mode: bug ? 'missing-bug-edge' : 'missing-ticket-edge',
      label: bug ? 'a bug-sourced edge no case covers (a real defect could slip through)' : 'a required ticket edge no case covers',
      severity: bug ? 'critical' : 'high', where: `${repo}#${t.iid} ${id}`, detail: reason(id),
    });
  }
  for (const id of stats.flaky) {
    console.log(`  ${repo}#${t.iid} ${id} [${edgeOf.get(id)?.source}] flaky: covered in ${hitsOf.get(id)}/${stats.trials} trials — the judge flips on it (noise).`);
    diag.push({ mode: 'flaky-edge', label: 'coverage the judge flips on between trials (noise, not a real gap)', severity: 'medium', where: `${repo}#${t.iid} ${id}`, detail: `covered in ${hitsOf.get(id)}/${stats.trials} trials` });
  }
  const labelled = t.edges.filter((e) => e.truth !== undefined);
  const majorityOf = (id: string): boolean => majorityCovered({ id, hits: hitsOf.get(id) ?? 0, trials: stats.trials });
  const agreed = labelled.filter((e) => (majorityOf(e.id) ? 'covered' : 'none') === e.truth);
  for (const e of labelled) {
    if (!agreed.includes(e)) {
      console.log(`  ${repo}#${t.iid} ${e.id} judge disagreed with gold truth '${e.truth}': ${reason(e.id)}`);
      diag.push({ mode: 'judge-vs-gold', label: 'the judge disagreed with a known gold truth (its own error rate)', severity: 'info', where: `${repo}#${t.iid} ${e.id}`, detail: `gold '${e.truth}': ${reason(e.id)}` });
    }
  }
  const bugIds = new Set(t.edges.filter((e) => e.source === 'bug').map((e) => e.id));
  return {
    repo, iid: Number(t.iid),
    covered: stats.coveredEveryTrial.length, edges: t.edges.length,
    bugCovered: stats.coveredEveryTrial.filter((id) => bugIds.has(id)).length, bugEdges: bugIds.size,
    missing: stats.missingEveryTrial,
    wellFormed: wellFormedCount, cases: caseCount,
    truthChecked: labelled.length, truthAgreed: agreed.length,
    trials: stats.trials, flaky: stats.flaky, spread: stats.spread,
    minCovered: stats.minCovered, maxCovered: stats.maxCovered,
    diag,
  };
}

/**
 * Judge a fixed on-disk list k times; the list is identical each trial, so only
 * the judge varies. A list with no well-formed case covers no edge, so it is
 * scored 0/edges without paying the judge — not dropped, which would hide the
 * regression that degenerated the list.
 */
async function scoreFixed(t: Target, cases: Case[], repeat: number, model: string): Promise<TicketScore> {
  const wellFormedCount = cases.filter(wellFormed).length;
  if (!wellFormedCount) {
    console.log(`${repoName(t.project)}#${t.iid}: ${cases.length} case(s) but none have steps and a concrete expected result, so none can cover any edge; scored 0/${t.edges.length}, judge skipped`);
  }
  const sets: Array<Set<string>> = [];
  let lastVerdicts = new Map<string, Verdict>();
  for (let n = 0; n < repeat; n++) {
    if (!wellFormedCount) { sets.push(new Set()); continue; }
    lastVerdicts = new Map((await judge(t.edges, cases, model)).map((v) => [v.edge, v]));
    sets.push(coveredSet(t.edges, cases, lastVerdicts));
  }
  return scoreTicket(t, tallyTrials(t.edges.map((e) => e.id), sets), lastVerdicts, wellFormedCount, cases.length);
}

/**
 * Replay the testcases phase k times, judging each fresh list; both the list
 * and the judge vary. replay-testcases.ts derives the project from the on-disk
 * run at state/runs/<iid>, so when two gold projects share an iid both targets
 * would replay the same run — grade only the one whose run.json matches this
 * target's project, mirroring liveCases.
 */
async function scoreReplayed(t: Target, repeat: number, label: string | undefined, model: string): Promise<TicketScore | null> {
  const repo = repoName(t.project);
  const source = readJson<{ url: string }>(join(STATE, 'runs', t.iid, 'run.json'));
  if (!source?.url.startsWith(`${t.project}/`)) {
    console.log(`${repo}#${t.iid}: state/runs/${t.iid} is not a ${t.project} run, skipped (its list belongs to another project's edges)`);
    return null;
  }
  const sets: Array<Set<string>> = [];
  let lastVerdicts = new Map<string, Verdict>();
  let caseCount = 0; let wellFormedCount = 0;
  for (let n = 0; n < repeat; n++) {
    const cases = await replay(t.iid, `${label ?? 'eval'}${repeat > 1 ? `-t${n + 1}` : ''}`);
    if (!cases?.length) continue;
    caseCount = cases.length;
    wellFormedCount = cases.filter(wellFormed).length;
    if (!wellFormedCount) { sets.push(new Set()); continue; }
    lastVerdicts = new Map((await judge(t.edges, cases, model)).map((v) => [v.edge, v]));
    sets.push(coveredSet(t.edges, cases, lastVerdicts));
  }
  if (!sets.length) { console.log(`${repo}#${t.iid}: no test list to grade, skipped`); return null; }
  if (sets.length < repeat) {
    console.log(`${repo}#${t.iid}: only ${sets.length}/${repeat} replays produced a list; scored on ${sets.length} trial(s), so its noise band rests on fewer samples than requested`);
  }
  return scoreTicket(t, tallyTrials(t.edges.map((e) => e.id), sets), lastVerdicts, wellFormedCount, caseCount);
}

function totals(tickets: TicketScore[]): { covered: number; edges: number; bugCovered: number; bugEdges: number } {
  const sum = (k: 'covered' | 'edges' | 'bugCovered' | 'bugEdges'): number => tickets.reduce((a, t) => a + t[k], 0);
  return { covered: sum('covered'), edges: sum('edges'), bugCovered: sum('bugCovered'), bugEdges: sum('bugEdges') };
}

function report(now: TicketScore[], base: Saved<EdgeScores> | null): void {
  const was = (t: TicketScore): TicketScore | undefined => base?.data.tickets.find((b) => b.repo === t.repo && b.iid === t.iid);
  const repeated = now.some((t) => (t.trials ?? 1) > 1);
  console.table(now.map((t) => ({
    repo: t.repo, iid: t.iid,
    covered: `${t.covered}/${t.edges}`, bugCovered: `${t.bugCovered}/${t.bugEdges}`,
    wellFormed: `${t.wellFormed}/${t.cases}`,
    ...(repeated ? { spread: `${t.minCovered}–${t.maxCovered}`, flaky: t.flaky.length } : {}),
    ...(base ? { [`was (${base.label})`]: was(t) ? `${was(t)!.covered}/${was(t)!.edges}, bug ${was(t)!.bugCovered}/${was(t)!.bugEdges}` : '—' } : {}),
  })));
  const n = totals(now);
  console.log(`now:  ${n.covered}/${n.edges} edges, ${n.bugCovered}/${n.bugEdges} bug edges`);
  if (repeated) {
    const flaky = now.reduce((a, t) => a + (t.flaky?.length ?? 0), 0);
    const band = now.reduce((a, t) => a + (t.spread ?? 0), 0);
    const trials = Math.max(...now.map((t) => t.trials ?? 1));
    console.log(`noise: ${flaky} edge(s) flipped across ${trials} trials of the same config; summed spread ${band} edges. A change smaller than the spread is judge noise, not signal.`);
  }
  const checked = now.reduce((a, t) => a + t.truthChecked, 0);
  if (checked) {
    const agreed = now.reduce((a, t) => a + t.truthAgreed, 0);
    console.log(`judge accuracy: ${agreed}/${checked} edges matched gold truth (${checked - agreed} disagreement(s)) — the judge's own error rate, to weigh its verdicts by.`);
  }
  for (const line of formatFailureModes(rankFailureModes(now.flatMap((t) => t.diag ?? [])))) console.log(line);
  if (!base) return;
  const both = now.filter(was);
  const b = totals(both.map((t) => was(t)!));
  const m = totals(both);
  const noiseBand = both.reduce((a, t) => a + (t.spread ?? 0), 0);
  const delta = m.covered - b.covered;
  const verdict = repeated ? `, ${beyondNoise(delta, noiseBand) ? 'beyond the noise band' : 'within noise — not a real change'}` : '';
  console.log(`was:  ${b.covered}/${b.edges} edges, ${b.bugCovered}/${b.bugEdges} bug edges   `
    + `(${base.label}, ${base.mode}, oneshot ${base.oneshot}, ${base.at.slice(0, 10)}; over the ${both.length} ticket(s) both scored)`);
  console.log(`then→now on those: edges ${b.covered}→${m.covered} (Δ${delta >= 0 ? '+' : ''}${delta}${verdict}), bug edges ${b.bugCovered}→${m.bugCovered}`);
  for (const t of both) {
    const prev = was(t)!;
    const lost = t.missing.filter((id) => !prev.missing.includes(id));
    if (lost.length) console.log(`  REGRESSED ${t.repo}#${t.iid}: ${lost.join(', ')} covered before, missing now`);
    const wobbly = (t.flaky ?? []).filter((id) => !prev.missing.includes(id));
    if (wobbly.length) console.log(`  FLAKY NOW ${t.repo}#${t.iid}: ${wobbly.join(', ')} covered before, intermittently covered now`);
  }
}

async function main(): Promise<void> {
  const gold = readJson<GoldFile>(GOLD);
  if (!gold) { console.error(`cannot read ${GOLD}`); process.exit(2); }
  const argv = process.argv.slice(2);
  const replaying = argv.includes('--replay');
  const label = argValue(argv, '--label');
  if (argv.includes('--save') && !label) { console.error('--save needs --label <name>, e.g. --label prompt-a'); process.exit(2); }
  const repeat = Math.max(1, Math.floor(Number(argValue(argv, '--repeat') ?? 1)) || 1);
  const only = argv.filter((a, i) => /^\d+$/.test(a) && !VALUE_FLAGS.has(argv[i - 1] ?? ''));
  const targets: Target[] = Object.entries(gold.projects)
    .flatMap(([project, tickets]) => Object.entries(tickets).map(([iid, edges]) => ({ project, iid, edges })))
    .filter(({ iid }) => !only.length || only.includes(iid));
  const model = judgeModel();

  const guarded = async (t: Target, run: () => Promise<TicketScore | null>): Promise<TicketScore | null> => {
    try { return await run(); } catch (err) {
      console.log(`${repoName(t.project)}#${t.iid}: judge failed, skipped — ${(err as Error).message}`);
      return null;
    }
  };

  let scored: Array<TicketScore | null>;
  if (replaying) {
    const iids = targets.map((t) => t.iid);
    const width = new Set(iids).size === iids.length ? REPLAY_PARALLEL : 1;
    scored = await pool(targets.map((t) => () => guarded(t, () => scoreReplayed(t, repeat, label, model))), width);
  } else {
    scored = await Promise.all(targets.map((t) => guarded(t, () => {
      const cases = liveCases(t.project, t.iid);
      if (!cases?.length) { console.log(`${repoName(t.project)}#${t.iid}: no test list to grade, skipped`); return Promise.resolve(null); }
      return scoreFixed(t, cases, repeat, model);
    })));
  }
  const tickets = scored.filter((t): t is TicketScore => t !== null)
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.iid - b.iid);

  console.log(`\njudge: ${model}. ${repeat > 1 ? `${repeat} trials/ticket requested. ` : ''}graded ${replaying ? 'fresh replays of the current prompt' : "each run's first test list, before QA feedback"}.`);
  report(tickets, loadHistory<EdgeScores>(ROOT, KIND, argValue(argv, '--vs')));
  if (argv.includes('--save')) {
    console.log(`saved ${saveHistory(ROOT, KIND, label!, replaying ? 'replay' : 'live', { judge: model, tickets })}`);
  }
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });

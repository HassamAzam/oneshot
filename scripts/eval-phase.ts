/**
 * Replay ONE phase on stored tickets, N times each, and grade every answer.
 *
 * docs/FIX-PLAN.md §7: the smallest loop that can show a prompt change moved a
 * score on the same inputs. Not a framework — one phase is wired (`recall`),
 * and the next one is a grader function added to GRADERS.
 *
 * Inputs are frozen on this machine so two runs differ only by the prompt:
 *   - tickets are fetched from GitLab once and cached in state/evals/tickets/
 *   - the memory is snapshotted once into state/evals/memory/ and copied into
 *     the dry home before every replay
 * Frozen per machine, not shipped: both live under the gitignored state/, and
 * the gold labels were judged against one particular snapshot of one
 * machine's runs. So evals/<phase>/gold.json says what it was judged against —
 * each case's project, and the memory iids — and the eval holds the machine to
 * it rather than grading its own state against labels written for another's:
 * a case from another project is read from that run's transcript or refused,
 * and a snapshot that holds different runs skips the gold check (see main).
 *
 * It runs the phase through the production runPhase — same prompt builder,
 * model tier, schema, hooks and tool policy — under DRY_RUN, whose shadow home
 * (state-dry/) keeps every side effect runPhase has (artifact, transcript,
 * quota row, event row) away from the live runs and the live board.
 *
 *   npm run eval -- recall                 # the gold tickets, 3 samples each
 *   npm run eval -- recall 247 28 --n 5
 *   npm run eval -- recall --refresh-memory  # re-snapshot memory, keep the cached tickets
 *   npm run eval -- recall --refetch         # re-read the tickets, keep the snapshot
 *
 * The two are separate because they go stale for different reasons: memory
 * grows with every completed run, while a ticket only needs re-reading when it
 * was edited. Re-reading also means asking GitLab, which only knows the ONE
 * project GITLAB_REPO_URL names today — see loadTicket.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DRY_RUN, MEMORY, ROOT, budgetConfig, phaseByName } from '../src/lib/config.js';
import { allIssueNotes, getIssue } from '../src/lib/gitlab.js';
import { currentProjectKey } from '../src/lib/journalproject.js';
import { repoKey } from '../src/lib/repourl.cjs';
import { promptFor, systemPromptFor, type PromptCtx } from '../src/phases/prompts.js';
import { runPhase } from '../src/conductor/phase.js';
import { ticketComments } from '../src/conductor/runner.js';
import { transcriptPath, type RunJournal } from '../src/lib/artifacts.js';
import type { Ticket } from '../src/phases/types.js';

// config.ts picks the state home at import time, so the flag has to be in the
// environment before this file loads — the npm script sets it. Refusing here is
// what stops a bare `tsx scripts/eval-phase.ts` overwriting a live run's artifact.
if (!DRY_RUN) {
  console.error('Run this through `npm run eval`: it needs DRY_RUN=1 so replays land in state-dry/, not state/.');
  process.exit(2);
}

const EVALS = join(ROOT, 'state', 'evals');
const LIVE_MEMORY = join(ROOT, 'state', 'memory');
const SNAPSHOT = join(EVALS, 'memory');
const TICKETS = join(EVALS, 'tickets');
const PARALLEL = 4;

/** `project` is the GitLab project the case's ticket lives in, as a web URL. */
interface Gold { project: string; must: number[]; ok: number[]; why: string }
/** `memory`: the iids the snapshot held when the cases were labelled. */
interface GoldFile { memory?: number[]; cases: Record<string, Gold> }
interface Check { name: string; pass: boolean; note?: string }
interface ToolCall { name: string; input: Record<string, unknown> }
type Grader = (out: Record<string, unknown>, ticket: Ticket, gold: Gold | undefined) => Check[];

// ---------------------------------------------------------------- graders --

/** The iids the frozen memory actually holds, from either half of it. */
function memoryIids(): Set<number> {
  const ids = new Set<number>();
  const index = join(SNAPSHOT, 'index.jsonl');
  if (existsSync(index)) {
    for (const line of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
      try { ids.add(Number(JSON.parse(line).iid)); } catch { /* a torn line is not a ticket */ }
    }
  }
  const cards = join(SNAPSHOT, 'tickets');
  if (existsSync(cards)) {
    for (const f of readdirSync(cards)) if (/^\d+\.md$/.test(f)) ids.add(Number(f.slice(0, -3)));
  }
  return ids;
}

/**
 * What the frozen memory says each run touched: its index `files` plus its card
 * text, so a path the brief names can be traced back to a run that cited it.
 */
function memoryRecords(): Map<number, string> {
  const text = new Map<number, string>();
  const index = join(SNAPSHOT, 'index.jsonl');
  if (existsSync(index)) {
    for (const line of readFileSync(index, 'utf8').split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line) as { iid: number; files?: string[] };
        text.set(Number(j.iid), (j.files ?? []).join('\n'));
      } catch { /* a torn line is not a ticket */ }
    }
  }
  const cards = join(SNAPSHOT, 'tickets');
  if (existsSync(cards)) {
    for (const f of readdirSync(cards)) {
      if (!/^\d+\.md$/.test(f)) continue;
      const iid = Number(f.slice(0, -3));
      text.set(iid, `${text.get(iid) ?? ''}\n${readFileSync(join(cards, f), 'utf8')}`);
    }
  }
  return text;
}

/**
 * A file path: directory-qualified with any extension, or a bare root-level
 * name (README.md, ThemedApp.js) with a source extension — a bare `x.y` alone
 * would catch "e.g" and version numbers.
 */
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+(?:\.[\w-]+)*\.(?:py|jsx?|tsx?|mjs|cjs|json|md|html|s?css|ya?ml|sql|sh|vue)\b/g;

const paths = (text: string): string[] => (text.match(PATH_RE) ?? []).map((p) => p.replace(/^\.\//, ''));

/** docs/rubrics/recall.md, check for check. Judges the answer only — see outOfMemory. */
const gradeRecall: Grader = (out, ticket, gold) => {
  const prior = (out.priorTickets as Array<{ iid: number; gotchas?: string[] }>) ?? [];
  const cited = prior.map((p) => Number(p.iid));
  const brief = String(out.brief ?? '').trim();
  const known = memoryIids();
  // Out-of-scope work that reached the answer: a file path no cited run touched
  // is the phase's own code research (or an invention), and it is pasted into
  // research, plan, implement and review all the same.
  const citedText = cited.map((i) => memoryRecords().get(i) ?? '').join('\n');
  // A named path is grounded when it is a cited path or a trailing run of its
  // segments: views/shared.py and shared.py both point at
  // apps/core/api/v1/views/shared.py; ents/shared.py and other/views/shared.py do not.
  // Matching on a segment boundary, not as a substring, is what keeps a path
  // that merely ends in the same characters from passing; scoring a partly
  // qualified path below the bare filename would reward vaguer answers.
  const citedPaths = [...new Set(paths(citedText))];
  const named = paths([brief, ...prior.flatMap((p) => p.gotchas ?? [])].join('\n'));
  const ungrounded = [...new Set(named)].filter((p) => !citedPaths.some((c) => c === p || c.endsWith(`/${p}`)));
  const checks: Check[] = [
    { name: 'no-self', pass: !cited.includes(ticket.iid) },
    {
      name: 'real',
      pass: cited.every((i) => known.has(i)),
      note: cited.filter((i) => !known.has(i)).map((i) => `#${i} not in memory`).join(', '),
    },
    {
      name: 'empty-is-empty',
      pass: (cited.length === 0) === (brief === ''),
      note: cited.length === 0 && brief ? `no tickets but a ${brief.length}-char brief` : '',
    },
    {
      name: 'cites-iid',
      pass: cited.every((i) => new RegExp(`#${i}\\b`).test(brief)),
    },
    { name: 'short', pass: brief.length <= 1000, note: `${brief.length} chars` },
    { name: 'files-grounded', pass: ungrounded.length === 0, note: ungrounded.join(', ') },
  ];
  if (gold) {
    const missing = gold.must.filter((i) => !cited.includes(i));
    const extra = cited.filter((i) => !gold.must.includes(i) && !gold.ok.includes(i));
    checks.push({
      name: 'gold',
      pass: missing.length === 0 && extra.length === 0,
      note: [...missing.map((i) => `missed #${i}`), ...extra.map((i) => `cited #${i}`)].join(', '),
    });
  }
  return checks;
};

const GRADERS: Record<string, Grader> = { recall: gradeRecall };

/**
 * The tool calls that reached outside the memory. recall reads memory and
 * nothing else (prior-art-recall: "Reads the run memory only; never opens the
 * work repo, never traces code") — the live #193 run read index.jsonl and then
 * spent 44 calls exploring the workstreamai frontend. The prompt names memory
 * by absolute path, so a call that names no absolute path at all is working
 * relative to the conductor repo, which is outside it too.
 *
 * Reported beside the cost, never scored: the score judges the answer, and
 * exploration that leaves the answer clean is spend, not a wrong answer.
 * Exploration that leaks INTO the answer is caught by files-grounded and
 * empty-is-empty.
 */
function outOfMemory(calls: ToolCall[]): string[] {
  const inMemory = (p: string): boolean => p.startsWith(MEMORY) || p.endsWith('/prior-art-recall/SKILL.md');
  const out: string[] = [];
  for (const c of calls) {
    if (c.name === 'StructuredOutput' || c.name === 'Skill' || c.name === 'TodoWrite') continue;
    const paths = ['Read', 'Glob', 'Grep', 'LS'].includes(c.name)
      ? [String(c.input.file_path ?? c.input.path ?? '')]
      : c.name === 'Bash'
        ? String(c.input.command ?? '').match(/\/[^\s'"|;&)<>]+/g) ?? []
        : null;
    if (!paths) { out.push(c.name); continue; }
    if (!paths.length || !paths.every((p) => p && inMemory(p))) {
      out.push(`${c.name} ${paths.find((p) => !inMemory(p)) || '(cwd)'}`);
    }
  }
  return out;
}

/**
 * The tool calls one sample made. runPhase APPENDS to the tee, and every eval
 * of the same iid and sample number lands on the same file, so only the bytes
 * written after `from` belong to this sample.
 */
function toolCalls(tee: string, from: number): ToolCall[] {
  if (!existsSync(tee)) return [];
  const calls: ToolCall[] = [];
  for (const line of readFileSync(tee).subarray(from).toString('utf8').split('\n').filter(Boolean)) {
    try {
      const m = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue;
      for (const b of m.message.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
        if (b.type === 'tool_use') calls.push({ name: String(b.name), input: b.input ?? {} });
      }
    } catch { /* a torn line is not a call */ }
  }
  return calls;
}

// ----------------------------------------------------------------- inputs --

/**
 * The ticket exactly as the live run's recall session was shown it.
 *
 * runPhase's tee keeps the stream but not the prompt; the CLI's own session log
 * under ~/.claude/projects keeps both, and its first user message IS
 * ticketBlock() followed by the phase text. Parsing it back gives the same
 * bytes the live run saw, and works with GitLab off the VPN.
 */
function ticketFromTranscript(iid: number): Ticket | null {
  const tee = join(ROOT, 'state', 'runs', String(iid), 'transcripts', 'recall-lap0.jsonl');
  if (!existsSync(tee)) return null;
  const sid = /"session_id":"([^"]+)"/.exec(readFileSync(tee, 'utf8'))?.[1];
  const projects = join(homedir(), '.claude', 'projects');
  const log = sid && readdirSync(projects).map((d) => join(projects, d, `${sid}.jsonl`)).find(existsSync);
  if (!log) return null;
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    const m = JSON.parse(line || '{}') as { type?: string; message?: { content?: unknown } };
    if (m.type !== 'user') continue;
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : (c as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
    const block = text.split("\n\nSearch this system's memory")[0]!.split(/\n\n### Documents (?:attached|linked)/)[0]!;
    const head = /^## Ticket #(\d+) — (.*)\n.*\nLabels: (.*)\n\n### Description\n/.exec(block);
    if (!head) return null;
    const rest = block.slice(head[0].length);
    const cut = rest.search(/\n(?:### Comments \(\d+\)|\(no comments\))/);
    const body = cut >= 0 ? rest.slice(0, cut) : rest;
    const comments = cut >= 0 ? rest.slice(cut).split(/\n--- comment \d+ ---\n/).slice(1) : [];
    return {
      iid, title: head[2]!,
      labels: head[3] === 'none' ? [] : head[3]!.split(', '),
      description: body.trim() === '(empty)' ? null : body,
      notes: comments,
    };
  }
  return null;
}

/** The live run's journal: state/runs on this machine, never the dry home. */
function liveJournal(iid: number): Partial<RunJournal> | null {
  const file = join(ROOT, 'state', 'runs', String(iid), 'run.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')) as Partial<RunJournal>; } catch { return null; }
}

/**
 * The project the live run on this iid belonged to, as a repoKey, or null with
 * no live run or one that cannot say.
 *
 * Memory and the gold set hold iids only, and those are per project: the gold
 * tickets were run on arbisoft/workstreamai, while GITLAB_REPO_URL now names
 * arbisoft/erp, whose #74 is a different ticket. Asking GitLab for such an iid
 * would grade recall on the wrong ticket and say nothing about it. Read the way
 * judgeJournalHome reads a journal: its stamp, else its ticket URL.
 */
function liveRunProject(iid: number): string | null {
  const j = liveJournal(iid);
  return j ? j.project || repoKey(j.url ?? '') : null;
}

/**
 * The project an iid's ticket is read from, as a repoKey. A gold case's own
 * `project` wins, because it says which ticket the labels were judged against
 * — and this machine's state/runs, the only other witness, holds none of them
 * on any machine but the one that labelled them. An iid named on the command
 * line with no gold entry falls back to its live run, then to the configured
 * project, which is all a bare number can mean there.
 */
function expectedProject(iid: number, gold: Gold | undefined): string | null {
  if (gold) return repoKey(gold.project);
  return liveRunProject(iid) ?? currentProjectKey();
}

/**
 * What the live run's first attempt at this phase cost — lap 0, because later
 * laps run on a different journal and some were cut short by a gate. Null when
 * the live run on this iid was for another project: that is another ticket.
 */
function liveCost(iid: number, phase: string, project: string | null): { turns: number; weighted: number; secs: number } | null {
  if (!project || liveRunProject(iid) !== project) return null;
  const phases = (liveJournal(iid) as { phases?: Array<{ phase: string; lap: number; turns: number; weighted: number; startedAt: number; endedAt: number }> } | null)?.phases ?? [];
  const first = phases.find((p) => p.phase === phase && p.lap === 0);
  return first ? { turns: first.turns, weighted: first.weighted, secs: (first.endedAt - first.startedAt) / 1000 } : null;
}

/** A cached ticket, stamped with the project (repoKey) it was read for. */
interface CachedTicket { project: string; ticket: Ticket }

/**
 * The same ticket the runner builds (runner.ts fetchTicket), minus documents,
 * as it stands in `project` (a repoKey).
 *
 * GitLab is asked only when `project` is the configured one, since it answers
 * for GITLAB_REPO_URL's ticket of that number whatever was meant. Any other
 * project's ticket comes from the recall transcript of a live run of that same
 * project on this machine, or the eval refuses it. The cache carries the
 * project too: an entry read for another one, or before the stamp existed —
 * which is how erp tickets got cached under workstreamai gold iids — is read
 * again rather than reused.
 */
async function loadTicket(iid: number, project: string | null, refetch: boolean): Promise<Ticket> {
  if (!project) throw new Error(`#${iid}: no project to read it from — GITLAB_REPO_URL is unset or invalid`);
  const cached = join(TICKETS, `${iid}.json`);
  if (!refetch && existsSync(cached)) {
    const hit = JSON.parse(readFileSync(cached, 'utf8')) as Partial<CachedTicket>;
    if (hit.project === project && hit.ticket) return hit.ticket;
    console.log(`#${iid}: cached ticket was read for ${hit.project ?? 'an unrecorded project'}, not ${project} — reading it again`);
  }
  const save = (ticket: Ticket): Ticket => {
    mkdirSync(TICKETS, { recursive: true });
    writeFileSync(cached, JSON.stringify({ project, ticket } satisfies CachedTicket, null, 2));
    return ticket;
  };
  // A transcript under state/runs/<iid> is only this ticket's if that run was in the same project.
  const fromTranscript = (): Ticket | null => (liveRunProject(iid) === project ? ticketFromTranscript(iid) : null);
  const configured = currentProjectKey();
  if (project !== configured) {
    const offline = fromTranscript();
    if (!offline) throw new Error(`#${iid} belongs to ${project}; its recall transcript is not on this machine`);
    console.log(`#${iid}: belongs to ${project}, not ${configured ?? 'GITLAB_REPO_URL'} — using the prompt its live run saw`);
    return save(offline);
  }
  const res = await getIssue(iid);
  if (!res.ok || !res.data) {
    const offline = fromTranscript();
    if (!offline) throw new Error(`#${iid}: could not read the ticket from GitLab (${res.error ?? 'no data'}) nor from its recall transcript`);
    console.log(`#${iid}: GitLab unreachable — using the prompt the live run saw`);
    return save(offline);
  }
  const notes = await allIssueNotes(iid);
  // Never cache a ticket without its comments: the cache outlives the outage.
  if (!notes.ok || !notes.data) {
    const offline = fromTranscript();
    if (!offline) throw new Error(`#${iid}: could not read the ticket's comments from GitLab (${notes.error ?? 'no data'}) nor its recall transcript`);
    console.log(`#${iid}: GitLab comments unreachable — using the prompt the live run saw`);
    return save(offline);
  }
  // The ticket as the live run found it, as replay-plan reads it: a comment
  // posted afterwards ("same root cause as #29") would hand recall its answer
  // and make `vs live` compare runs on different inputs. No live run of this
  // project here, no cutoff.
  const before = liveRunProject(iid) === project ? liveJournal(iid)?.createdAt : undefined;
  return save({
    iid: res.data.iid,
    title: res.data.title,
    description: res.data.description,
    labels: res.data.labels,
    notes: ticketComments(notes.data, typeof before === 'number' ? before : undefined),
  });
}

function snapshotMemory(refresh: boolean): void {
  if (existsSync(SNAPSHOT) && !refresh) return;
  rmSync(SNAPSHOT, { recursive: true, force: true });
  cpSync(LIVE_MEMORY, SNAPSHOT, { recursive: true });
  console.log(`memory snapshot taken from ${LIVE_MEMORY}`);
}

/** Every replay starts from the snapshot, whatever the last one left behind. */
function stageMemory(): void {
  rmSync(MEMORY, { recursive: true, force: true });
  cpSync(SNAPSHOT, MEMORY, { recursive: true });
}

// ------------------------------------------------------------------- main --

interface Sample { iid: number; n: number; score: number; checks: Check[]; turns: number; weighted: number; secs: number; over: boolean; stray: number; error?: string }

async function pool<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const phase = argv[0] ?? '';
  const grade = GRADERS[phase];
  const cfg = phaseByName(phase);
  if (!grade || !cfg) {
    console.error(`usage: npm run eval -- <phase> [iid ...] [--n 3] [--refresh-memory] [--refetch]   phases: ${Object.keys(GRADERS).join(', ')}`);
    process.exit(2);
  }
  const nAt = argv.indexOf('--n');
  const n = nAt >= 0 ? Number(argv[nAt + 1]) : 3;
  if (!Number.isInteger(n) || n < 1) {
    console.error('--n needs a positive integer');
    process.exit(2);
  }
  if (argv.includes('--refresh')) {
    console.error('--refresh is split: --refresh-memory re-snapshots memory, --refetch re-reads the tickets.');
    process.exit(2);
  }
  const goldFile = join(ROOT, 'evals', phase, 'gold.json');
  const goldSet: GoldFile = existsSync(goldFile) ? JSON.parse(readFileSync(goldFile, 'utf8')) as GoldFile : { cases: {} };
  const gold = goldSet.cases;
  const unplaced = Object.keys(gold).filter((iid) => !repoKey(gold[iid]?.project ?? ''));
  if (unplaced.length) {
    console.error(`${goldFile}: no \`project\` on ${unplaced.map((i) => `#${i}`).join(', ')} — an iid alone does not say which ticket was labelled`);
    process.exit(2);
  }
  const iids = argv.slice(1).filter((a, i, all) => /^\d+$/.test(a) && all[i - 1] !== '--n').map(Number);
  const targets = iids.length ? iids : Object.keys(gold).map(Number);

  snapshotMemory(argv.includes('--refresh-memory'));
  stageMemory();
  // `gold` names which runs may be cited, so it holds only for the memory it was
  // labelled against; every other check holds for any memory. A different
  // snapshot drops that one check rather than scoring citations against labels
  // that name runs it does not hold.
  const held = [...memoryIids()].sort((a, b) => a - b);
  const labelled = goldSet.memory ? [...new Set(goldSet.memory)].sort((a, b) => a - b) : null;
  const goldHolds = !labelled || labelled.join() === held.join();
  const iidList = (xs: number[]): string => (xs.length ? xs.map((i) => `#${i}`).join(',') : 'nothing');
  if (!goldHolds) {
    console.warn(`snapshot holds ${iidList(held)}; gold was labelled against ${iidList(labelled ?? [])}: gold check skipped. `
      + `Restore that snapshot into ${SNAPSHOT} or re-label ${goldFile}.`);
  }
  const tag = new Date().toISOString().replace(/[:.]/g, '-');
  // Reported beside the score, never folded into it: the phase's own quota
  // budget and turn cap, so a runaway sample stands out.
  const budget = budgetConfig().phases?.[phase] ?? Infinity;
  const outDir = join(EVALS, phase, tag);

  const projects = new Map(targets.map((iid) => [iid, expectedProject(iid, gold[iid])]));
  const tickets = new Map<number, Ticket>();
  for (const iid of targets) tickets.set(iid, await loadTicket(iid, projects.get(iid) ?? null, argv.includes('--refetch')));

  const jobs = targets.flatMap((iid) => Array.from({ length: n }, (_, k) => async (): Promise<Sample> => {
    const ticket = tickets.get(iid)!;
    const ctx: PromptCtx = {
      ticket, runId: `eval-${tag}`, lap: k,
      journal: { runId: `eval-${tag}`, iid, title: ticket.title, phases: [] } as unknown as RunJournal,
      prior: {},
    };
    const tee = transcriptPath(iid, cfg.name, k);
    const from = existsSync(tee) ? statSync(tee).size : 0;
    const startedAt = Date.now();
    const res = await runPhase({
      iid, runId: `eval-${tag}-${iid}-${k}`, lap: k, cfg,
      prompt: promptFor(cfg, ctx), systemPrompt: systemPromptFor(cfg, ctx),
    });
    const secs = (Date.now() - startedAt) / 1000;
    const checks: Check[] = res.data ? grade(res.data, ticket, goldHolds ? gold[iid] : undefined) : [{ name: 'produced', pass: false, note: res.error ?? res.blocked ?? 'no output' }];
    const strays = outOfMemory(toolCalls(tee, from));
    const over = res.weighted > budget || res.turns >= (cfg.maxTurns ?? Infinity) || secs >= cfg.timeoutMin * 60;
    const score = checks.filter((c) => c.pass).length / checks.length;
    mkdirSync(join(outDir, String(iid)), { recursive: true });
    writeFileSync(join(outDir, String(iid), `${k}.json`), JSON.stringify({ output: res.data, checks, score, turns: res.turns, weighted: res.weighted, secs, over, strays }, null, 2));
    return { iid, n: k, score, checks, turns: res.turns, weighted: res.weighted, secs, over, stray: strays.length, error: res.error };
  }));
  const samples = await pool(jobs, PARALLEL);

  // Per ticket: mean score, and which checks failed in how many samples.
  const rows = targets.map((iid) => {
    const mine = samples.filter((s) => s.iid === iid);
    const fails = new Map<string, number>();
    for (const s of mine) for (const c of s.checks) if (!c.pass) fails.set(c.name, (fails.get(c.name) ?? 0) + 1);
    return {
      iid,
      score: mine.reduce((a, s) => a + s.score, 0) / mine.length,
      turns: mine.reduce((a, s) => a + s.turns, 0) / mine.length,
      weighted: mine.reduce((a, s) => a + s.weighted, 0) / mine.length,
      secs: mine.reduce((a, s) => a + s.secs, 0) / mine.length,
      over: mine.filter((s) => s.over).length,
      stray: mine.reduce((a, s) => a + s.stray, 0) / mine.length,
      live: liveCost(iid, phase, projects.get(iid) ?? null),
      failed: [...fails].map(([c, k]) => `${c} ${k}/${mine.length}`).join(', '),
    };
  });
  const overall = rows.reduce((a, r) => a + r.score, 0) / rows.length;

  const previous = existsSync(join(EVALS, phase))
    ? readdirSync(join(EVALS, phase)).filter((d) => d < tag && existsSync(join(EVALS, phase, d, 'summary.json'))).sort().pop()
    : undefined;
  const prev = previous
    ? JSON.parse(readFileSync(join(EVALS, phase, previous, 'summary.json'), 'utf8')) as { overall: number; rows: Array<{ iid: number; weighted: number }> }
    : null;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ phase, tag, n, overall, goldSkipped: !goldHolds, rows }, null, 2));

  /** Signed percent change, or a dash when there is nothing to compare with. */
  const delta = (now: number, then: number | undefined): string =>
    then ? `${now >= then ? '+' : ''}${Math.round(((now - then) / then) * 100)}%` : '—';
  const sum = (xs: number[]): number => xs.reduce((a, x) => a + x, 0);

  console.log(`\n${phase} eval — ${targets.length} tickets × ${n} samples   ${outDir}\n`);
  console.log('ticket   score  turns  weighted  vs live  vs prev   secs  vs live  stray  over  failed checks');
  for (const r of rows) {
    console.log([
      `#${String(r.iid).padEnd(6)}`, r.score.toFixed(2).padStart(5),
      r.turns.toFixed(1).padStart(5), Math.round(r.weighted).toString().padStart(8),
      delta(r.weighted, r.live?.weighted).padStart(7),
      delta(r.weighted, prev?.rows.find((p) => p.iid === r.iid)?.weighted).padStart(7),
      Math.round(r.secs).toString().padStart(5), delta(r.secs, r.live?.secs).padStart(7),
      r.stray.toFixed(1).padStart(5), `${r.over}/${n}`.padStart(4), r.failed || '—',
    ].join('  '));
  }
  console.log('\nweighted = mean weighted tokens per sample (the config/budgets.json unit)');
  console.log("vs live  = change against the live run's first recall attempt; vs prev = against the last eval");
  console.log(`secs     = mean wall clock per sample, ${PARALLEL} replays at a time, so it runs above a lone live run`);
  console.log('stray    = mean tool calls outside memory, reported and not scored');
  console.log(`over     = samples past ${budget} weighted, ${cfg.maxTurns ?? '∞'} turns or the ${cfg.timeoutMin}m timeout`);
  if (!goldHolds) console.log('gold     = SKIPPED: the snapshot is not the memory gold.json was labelled against');
  const live = rows.filter((r) => r.live);
  console.log(`\noverall ${overall.toFixed(2)}   weighted ${Math.round(sum(rows.map((r) => r.weighted)))}`
    + (live.length ? `   vs live ${delta(sum(live.map((r) => r.weighted)), sum(live.map((r) => r.live!.weighted)))} over ${live.length} ticket(s)` : ''));
  if (prev) {
    console.log(`previous ${Number(prev.overall).toFixed(2)}  (${previous}) — only comparable if the tickets and n match`);
  }
}

main().catch((err: Error) => { console.error(err.message); process.exit(1); });

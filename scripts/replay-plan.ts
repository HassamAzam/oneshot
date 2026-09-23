/**
 * `npm run replay -- <iid>` — re-run a ticket's plan phase from a finished
 * run's saved artifacts, with no feedback and nothing posted, and score the
 * result against `evals/plan/<iid>.json`.
 *
 * Why this exists: the only way to find out whether a skill or prompt change
 * made plans better was to let a live run reach the plan gate, read the plan,
 * and write feedback — which steers that one ticket and teaches the harness
 * nothing. A replay asks the question the harness needs answered: with THIS
 * checkout's skills, prompts and schemas, does the plan catch the gaps a human
 * found last time, unaided?
 *
 *   npm run replay -- <iid>                     plan only, from the run's research.json
 *   npm run replay -- <iid> --from research     research then plan, to test research changes
 *   npm run replay -- <iid> --label skill-x     tag the output directory
 *   npm run replay -- <iid> --research <path>   plan again on an earlier replay's research
 *
 * To grade a plan that already exists, run nothing: `npm run score`.
 *
 * What makes it unaided and silent:
 * - DRY_RUN is forced before config loads: every GitLab write tool is removed
 *   from the session, the guards refuse pushes, and state goes to state-dry/.
 * - The ticket is re-read (read-only) keeping only comments posted BEFORE the
 *   original run started, so the plan it published and the feedback on that
 *   plan never reach the prompt. The snapshot is cached and reused.
 * - The journal handed to the prompt is fresh: no planApproval, no feedback.
 * - The code is a detached worktree at the original run's fork point, so the
 *   session reads what the original read, not whatever implement committed.
 * - Skills come from THIS checkout's context/ (plus skills/), not the machine's
 *   ONESHOT_SKILLS_ROOT, so what gets scored is the branch under test. Pass
 *   --skills-root to override.
 *
 * The phase runs on its own configured schema, the same one a live run gets:
 * this measures the harness as configured, and a replay that supplied its own
 * schema would be measuring something no ticket will ever meet.
 *
 * Output: state/replays/<iid>/<stamp>-<label>/ with research.json (when run),
 * plan.json, the transcripts, score.json and meta.json (cost, turns, the skills
 * the sessions actually launched, the Oneshot commit).
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  judgePrompt, normaliseScorecard, points, SCORECARD_SCHEMA, scoreTable,
  skillsInvoked, transcriptResult, type EvalSet, type Scorecard,
} from '../src/replay/score.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Args {
  iid: number;
  from: 'research' | 'plan';
  label: string;
  source: string;
  base?: string;
  skillsRoot: string;
  /** A research.json to plan from instead of the source run's — e.g. an earlier replay's. */
  research?: string;
  keepWorktree: boolean;
  refreshTicket: boolean;
  /** The judge's model tier; heavy (Opus) unless a cheaper tier is shown to agree with it. */
  judgeTier: 'standard' | 'heavy';
}

const USAGE = 'usage: npm run replay -- <iid> [--from research|plan] [--label <name>] [--source <run dir>] '
  + '[--base <sha>] [--skills-root <dir>] [--research <research.json>] [--keep-worktree] '
  + '[--refresh-ticket] [--judge-tier standard|heavy]';

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    from: 'plan', label: 'replay', keepWorktree: false, refreshTicket: false, judgeTier: 'heavy',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === '--from') {
      const v = next();
      if (v !== 'research' && v !== 'plan') throw new Error(`--from is research or plan\n${USAGE}`);
      a.from = v;
    } else if (arg === '--label') a.label = next().replace(/[^\w.-]+/g, '-');
    else if (arg === '--source') a.source = resolve(next());
    else if (arg === '--base') a.base = next();
    else if (arg === '--skills-root') a.skillsRoot = resolve(next());
    else if (arg === '--research') a.research = resolve(next());
    else if (arg === '--judge-tier') {
      const v = next();
      if (v !== 'standard' && v !== 'heavy') throw new Error(`--judge-tier is standard or heavy\n${USAGE}`);
      a.judgeTier = v;
    } else if (arg === '--keep-worktree') a.keepWorktree = true;
    else if (arg === '--refresh-ticket') a.refreshTicket = true;
    else if (/^\d+$/.test(arg)) a.iid = Number(arg);
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!a.iid) throw new Error(USAGE);
  if (a.research && a.from === 'research') {
    throw new Error(`--research plans from a saved research.json; it cannot be combined with --from research\n${USAGE}`);
  }
  // The conductor's own state dir, which a checkout used only for evaluation
  // may not have — hence --source, and a startup failure rather than a run
  // against an empty journal.
  a.source ??= join(ROOT, 'state', 'runs', String(a.iid));
  a.skillsRoot ??= join(ROOT, 'context');
  return a as Args;
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const args = parseArgs(process.argv.slice(2));

// Before ANY import that reaches src/lib/config.ts: both are read once, at load.
process.env.DRY_RUN = '1';
process.env.ONESHOT_SKILLS_ROOT = args.skillsRoot;

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { modelFor, phaseByName, runDir, WORK_REPO } = await import('../src/lib/config.js');

const evalsPath = join(ROOT, 'evals', 'plan', `${args.iid}.json`);
const evals = existsSync(evalsPath) ? readJson<EvalSet>(evalsPath) : null;

async function judge(plan: Record<string, unknown>): Promise<Scorecard | null> {
  if (!evals) {
    console.log(`no checklist at ${evalsPath} — skipping the score`);
    return null;
  }
  const model = modelFor({ name: 'replay-judge', tier: args.judgeTier } as never);
  const q = query({
    prompt: judgePrompt(evals, plan),
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
  return normaliseScorecard(evals, raw);
}

const { fetchTicket } = await import('../src/conductor/runner.js');
const { runPhase } = await import('../src/conductor/phase.js');
const { promptFor, systemPromptFor } = await import('../src/phases/prompts.js');
const { replayWorktree, removeReplayWorktree, runForkPoint } = await import('../src/lib/worktrees.js');
type RunJournal = import('../src/lib/artifacts.js').RunJournal;
type Ticket = import('../src/phases/types.js').Ticket;

const journal = readJson<RunJournal>(join(args.source, 'run.json'));
const replayRoot = join(ROOT, 'state', 'replays', String(args.iid));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(replayRoot, `${stamp}-${args.label}`);
mkdirSync(outDir, { recursive: true });

// The ticket as the original run saw it.
const ticketPath = join(replayRoot, 'ticket.json');
let ticket: Ticket;
if (existsSync(ticketPath) && !args.refreshTicket) {
  ticket = readJson<Ticket>(ticketPath);
} else {
  const fetched = await fetchTicket(args.iid, { notesBefore: journal.createdAt });
  if (!fetched) throw new Error(`could not read ticket #${args.iid} from GitLab`);
  ticket = fetched;
  writeFileSync(ticketPath, `${JSON.stringify(ticket, null, 2)}\n`);
}

const base = args.base ?? (journal.branch ? runForkPoint(journal.branch) : null);
if (!base) throw new Error('the journal names no branch to find the fork point from — pass --base <sha>');
const oneshotSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const runId = `replay-${args.iid}-${stamp}`;
const worktree = replayWorktree(runId, base);

// A previous replay's artifacts must not reach this one as `prior`. This is
// safe to delete outright because DRY_RUN was set before config.ts loaded, so
// ONESHOT_HOME — and every path under it, runDir included — is state-dry/.
// The run being replayed is read from --source under the REAL state/ and is
// never written to: a parked run can be replayed without disturbing it.
rmSync(runDir(args.iid), { recursive: true, force: true });

console.log(`replay    #${args.iid} from ${args.from} at ${WORK_REPO}@${base.slice(0, 9)}`);
console.log(`oneshot   ${oneshotSha}   skills ${args.skillsRoot}`);
console.log(`worktree  ${worktree}`);
console.log(`output    ${outDir}`);

const freshJournal: RunJournal = {
  runId, iid: args.iid, title: ticket.title, url: journal.url, createdAt: Date.now(),
  status: 'running', phases: [],
};
const prior: Record<string, Record<string, unknown> | null> = {
  recall: existsSync(join(args.source, 'recall.json')) ? readJson(join(args.source, 'recall.json')) : null,
};
if (args.from === 'plan') prior.research = readJson(args.research ?? join(args.source, 'research.json'));

const meta: Record<string, unknown> = {
  iid: args.iid, label: args.label, from: args.from, oneshot: oneshotSha, base,
  skillsRoot: args.skillsRoot, sourceRun: journal.runId, research: args.research ?? null, phases: {},
};

let exitCode = 0;
try {
  for (const name of args.from === 'research' ? ['research', 'plan'] : ['plan']) {
    const cfg = phaseByName(name);
    if (!cfg) throw new Error(`config/phases.json has no ${name} phase`);
    const ctx = { ticket, runId, lap: 0, worktree, journal: freshJournal, prior };
    const started = Date.now();
    console.log(`\n${name}  running (${cfg.maxTurns} turns, ${cfg.timeoutMin} min cap)`);
    const out = await runPhase({
      iid: args.iid, runId, lap: 0, cfg,
      prompt: promptFor(cfg, ctx), systemPrompt: systemPromptFor(cfg, ctx), worktree,
    });

    const transcript = join(runDir(args.iid), 'transcripts', `${name}-lap0.jsonl`);
    const text = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
    if (text) copyFileSync(transcript, join(outDir, `${name}.jsonl`));
    const { costUsd } = transcriptResult(text);
    const skills = skillsInvoked(text);
    (meta.phases as Record<string, unknown>)[name] = {
      ok: out.ok, turns: out.turns, costUsd, minutes: Math.round((Date.now() - started) / 6000) / 10,
      skillsInvoked: skills, blocked: out.blocked, error: out.error,
    };
    console.log(`${name}  ${out.ok ? 'ok' : 'FAILED'} · ${out.turns} turns · $${costUsd.toFixed(2)} · skills: ${skills.join(', ') || 'none'}`);
    if (!out.ok || !out.data) {
      exitCode = 1;
      break;
    }
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(out.data, null, 2)}\n`);
    prior[name] = out.data;
  }

  if (exitCode === 0 && prior.plan) {
    const card = await judge(prior.plan);
    if (card) {
      writeFileSync(join(outDir, 'score.json'), `${JSON.stringify(card, null, 2)}\n`);
      meta.score = points(card);
      console.log(`\nscore\n${scoreTable(evals!, card)}`);
      if (card.notes) console.log(`  notes   ${card.notes}`);
    }
  }
} finally {
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  if (!args.keepWorktree) removeReplayWorktree(worktree);
}
process.exit(exitCode);

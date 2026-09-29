/**
 * `npm run replay -- <iid>` — re-run a ticket's plan phase from a finished
 * run's saved artifacts, with no feedback and nothing posted.
 *
 * Why this exists: the only way to find out whether a skill or prompt change
 * made plans better was to let a live run reach the plan gate, read the plan,
 * and write feedback — which steers that one ticket and teaches the harness
 * nothing. A replay asks the question the harness needs answered: with THIS
 * checkout's skills, prompts and schemas, what plan does the ticket get?
 *
 *   npm run replay -- <iid>                     plan only, from the run's research.json
 *   npm run replay -- <iid> --from research     research then plan, to test research changes
 *   npm run replay -- <iid> --label skill-x     tag the output directory
 *   npm run replay -- <iid> --research <path>   plan again on an earlier replay's research
 *
 * It produces the artifact and stops. Deciding whether the plan is any good is
 * a reading job, and the thing worth reading is the plan itself — what it
 * searched for, what prior art it names, what it decided not to do. A grade
 * stands in for that judgement without carrying it.
 *
 * What makes it unaided and silent:
 * - DRY_RUN is forced before config loads: every GitLab write tool is removed
 *   from the session, the guards refuse pushes, and state goes to state-dry/.
 * - The ticket is re-read (read-only) keeping only comments posted BEFORE the
 *   original run started, so the plan it published and the feedback on that
 *   plan never reach the prompt. The snapshot is cached per SOURCE RUN, since
 *   that is what the cutoff comes from.
 * - The journal handed to the prompt is fresh: no planApproval, no feedback.
 * - The code is a detached worktree at the original run's fork point, so the
 *   session reads what the original read, not whatever implement committed.
 * - Skills come from THIS checkout's context/ (plus skills/), not the machine's
 *   ONESHOT_SKILLS_ROOT, so what runs is the branch under test. Pass
 *   --skills-root to override.
 *
 * The phase runs on its own configured schema, the same one a live run gets:
 * this measures the harness as configured, and a replay that supplied its own
 * schema would be measuring something no ticket will ever meet.
 *
 * Output: state/replays/<iid>/<stamp>-<label>/ with research.json (when run),
 * plan.json, the transcripts, and meta.json — cost, turns, the skills the
 * sessions actually launched, and the Oneshot commit that produced them.
 * meta.json is the half you cannot get by reading the plan: a phase that
 * quietly spent its whole turn budget, or never loaded the skill it was
 * configured with, produces an artifact that looks ordinary.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillsInvoked, transcriptResult } from '../src/lib/transcript.js';

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
}

const USAGE = 'usage: npm run replay -- <iid> [--from research|plan] [--label <name>] [--source <run dir>] '
  + '[--base <sha>] [--skills-root <dir>] [--research <research.json>] [--keep-worktree] '
  + '[--refresh-ticket]';

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    from: 'plan', label: 'replay', keepWorktree: false, refreshTicket: false,
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
    else if (arg === '--keep-worktree') a.keepWorktree = true;
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
  // Here rather than at the point of use, which is after the worktree is
  // created and before the try/finally that removes it: a run that never
  // reached research, or a mistyped --research, would otherwise die on a raw
  // ENOENT and leave a detached worktree behind in the shared WT_ROOT.
  if (a.from === 'plan') {
    const research = a.research ?? join(a.source, 'research.json');
    if (!existsSync(research)) {
      throw new Error(`no research.json to plan from at ${research}\n`
        + `pass --research <path>, or --from research to produce one\n${USAGE}`);
    }
  }
  return a as Args;
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const args = parseArgs(process.argv.slice(2));

// Before ANY import that reaches src/lib/config.ts: both are read once, at load.
process.env.DRY_RUN = '1';
process.env.ONESHOT_SKILLS_ROOT = args.skillsRoot;

const { phaseByName, runDir, WORK_REPO } = await import('../src/lib/config.js');
const { transcriptPath } = await import('../src/lib/artifacts.js');

const { fetchTicket } = await import('../src/conductor/runner.js');
const { runPhase } = await import('../src/conductor/phase.js');
const { promptFor, systemPromptFor } = await import('../src/phases/prompts.js');
const { answerKeyCommits, replayWorktree, removeReplayWorktree, runForkPoint } = await import('../src/lib/worktrees.js');
type RunJournal = import('../src/lib/artifacts.js').RunJournal;
type Ticket = import('../src/phases/types.js').Ticket;

const journal = readJson<RunJournal>(join(args.source, 'run.json'));
const replayRoot = join(ROOT, 'state', 'replays', String(args.iid));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(replayRoot, `${stamp}-${args.label}`);
mkdirSync(outDir, { recursive: true });

// A previous replay's artifacts must not reach this one as `prior`. This is
// safe to delete outright because DRY_RUN was set before config.ts loaded, so
// ONESHOT_HOME — and every path under it, runDir included — is state-dry/.
// The run being replayed is read from --source under the REAL state/ and is
// never written to: a parked run can be replayed without disturbing it.
//
// Before the ticket fetch rather than after it: collectTicketDocs writes the
// ticket's attachments under runDir and documentsBlock tells the session to
// open them by local path, so wiping afterwards plans the ticket without its
// own spec while the prompt still claims the files are there.
rmSync(runDir(args.iid), { recursive: true, force: true });

// Comments as of the original run; description and labels are whatever they are
// now. Keyed by the SOURCE RUN, not the ticket: --source can name two runs of
// one ticket whose createdAt cutoffs differ, and reusing the newer snapshot
// would hand an earlier replay the comments it exists to withhold — including
// the gate note carrying the whole previous plan.
const ticketPath = join(replayRoot, `ticket-${journal.runId}.json`);
// The rmSync above removed any attachment an earlier replay downloaded, so a
// snapshot naming files that are gone is re-fetched rather than handed to a
// session as dead paths it was told to Read.
const docsPresent = (t: Ticket): boolean =>
  (t.documents ?? []).every((d) => !d.path || existsSync(d.path));
const cached = existsSync(ticketPath) && !args.refreshTicket
  ? readJson<Ticket>(ticketPath)
  : null;
let ticket: Ticket;
if (cached && docsPresent(cached)) {
  ticket = cached;
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

console.log(`replay    #${args.iid} from ${args.from} at ${WORK_REPO}@${base.slice(0, 9)}`);
console.log(`oneshot   ${oneshotSha}   skills ${args.skillsRoot}`);
console.log(`worktree  ${worktree}`);
console.log(`output    ${outDir}`);

// A worktree shares the work repo's objects, so a pre-fix base is a blind
// working tree in a repo that may still hold the fix. Say so rather than let
// the number be read as blind later. --base is exactly the path that gets here
// with a landed branch, because runForkPoint refuses and names it as the way out.
const answerKey = answerKeyCommits(args.iid, base);
if (answerKey.length) {
  console.log('');
  console.log(`NOT BLIND  ${answerKey.length} commit(s) reference #${args.iid} and are not in the base;`);
  console.log('           a phase that greps the history can read the fix it is meant to plan.');
  for (const c of answerKey) console.log(`           ${c}`);
  console.log('           recorded as answerKeyCommits in meta.json — see issue #155.');
  console.log('');
}

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
  skillsRoot: args.skillsRoot, sourceRun: journal.runId, research: args.research ?? null,
  // Empty means the run WAS blind: no commit naming this ticket is reachable
  // outside the base. Non-empty means the plan could have read the answer, so
  // the artifact says so on its face.
  answerKeyCommits: answerKey, phases: {},
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

    // transcriptPath, not a second copy of the convention: phase.ts writes the
    // file through it, and a hand-rolled path that drifts fails silently —
    // transcriptResult('') is $0 and skillsInvoked('') is [], so meta.json
    // would report a session that cost money and loaded skills as neither.
    const transcript = transcriptPath(args.iid, name, 0);
    const text = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
    if (text) copyFileSync(transcript, join(outDir, `${name}.jsonl`));
    const { costUsd } = transcriptResult(text);
    const skills = skillsInvoked(text);
    (meta.phases as Record<string, unknown>)[name] = {
      ok: out.ok, turns: out.turns, costUsd, minutes: Math.round((Date.now() - started) / 6000) / 10,
      // infra separates a dead harness from a configuration that could not
      // plan. Everywhere else in the repo keeps that apart (PhaseRecord has its
      // own 'infra' status); a rig that aggregates labelled replays is the last
      // place it should collapse into a bare ok:false.
      infra: out.infra ?? false, rateLimited: out.rateLimited ?? false,
      skillsInvoked: skills, blocked: out.blocked, error: out.error,
    };
    const verdict = out.ok ? 'ok' : (out.infra ? 'INFRA' : 'FAILED');
    console.log(`${name}  ${verdict} · ${out.turns} turns · $${costUsd.toFixed(2)} · skills: ${skills.join(', ') || 'none'}`);
    if (!out.ok && out.error) console.log(`      ${out.error.split('\n')[0]}`);
    if (!out.ok || !out.data) {
      exitCode = 1;
      break;
    }
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(out.data, null, 2)}\n`);
    prior[name] = out.data;
  }
} finally {
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  if (!args.keepWorktree) removeReplayWorktree(worktree);
}
process.exit(exitCode);

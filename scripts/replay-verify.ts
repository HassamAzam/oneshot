/**
 * `npm run replay:verify -- <iid>` — re-run a finished run's verify phase with
 * THIS checkout's prompts and skills, on the inputs its first verify session
 * had, with nothing posted.
 *
 *   npm run replay:verify -- <iid>                 the run in state/runs/<iid>
 *   npm run replay:verify -- <iid> --label v-v2    tag the output directory
 *   npm run replay:verify -- <iid> --source <run dir> --keep-worktree --refresh-ticket
 *
 * It exists so eval:causes can grade a verify-prompt change (`eval:causes --
 * --replay`): the verify.json a run holds on disk was written by whatever
 * prompt was live then, and grading it again after a prompt change measures
 * nothing. Unlike replay:testcases, verify EXECUTES the app — it leases a port,
 * builds the worktree, drives the real UI and fabricates state in the one local
 * Postgres every worktree shares — so replays cannot run in parallel.
 *
 * What the session is shown, and why it is not the run's artifacts on disk:
 * - research, plan, implement and testcases come from the transcript of the
 *   last lap of each that STARTED before verify lap 0. The whole-run artifacts
 *   hold the final lap, and a later implement lap's summary describes the fix
 *   for the very defect this verify should have caught. A phase with no such
 *   transcript falls back to its artifact, listed under priorFromArtifact.
 * - The code is a detached worktree at the branch's last commit before verify
 *   lap 0 started — the implemented change as verify first saw it, INCLUDING
 *   implement's commits. This is the opposite of replay:testcases, which stops
 *   at the fork point to stay blind: verify's whole job is to test that change.
 *   Commits naming the ticket reachable beyond it are answerKeyCommits.
 * - The test list the session verifies is the source run's testcases.json,
 *   seeded into the fresh run dir so readArtifact() finds it.
 * - The ticket is the one that session was shown, read back from its log under
 *   ~/.claude/projects, so no GitLab is needed. Without that log it is fetched
 *   keeping only comments posted before the run started.
 *
 * The project comes from the run's own URL, so an ERP and a workstreamai run
 * both replay from one checkout. Its clone is ONESHOT_<NAME>_WORK_REPO (worktrees
 * under ONESHOT_<NAME>_WT_ROOT); a WORK_REPO whose origin is another project is
 * refused rather than read.
 *
 * Output: state/replays/verify/<project>/<iid>/<stamp>-<label>/ with verify.json,
 * the testcases.json it graded against, the transcript and meta.json. The last
 * line printed is `OUTPUT <dir>` for a caller to pick up.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoKey } from '../src/lib/repourl.cjs';
import { skillsInvoked, transcriptResult } from '../src/lib/transcript.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIOR_PHASES = ['research', 'plan', 'implement', 'testcases'] as const;
const USAGE = 'usage: npm run replay:verify -- <iid> [--label <name>] [--source <run dir>] '
  + '[--keep-worktree] [--refresh-ticket]';

interface Args { iid: number; label: string; source: string; keepWorktree: boolean; refreshTicket: boolean }
interface PhaseRow { phase: string; lap: number; startedAt?: number }

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { label: 'replay', keepWorktree: false, refreshTicket: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === '--label') a.label = next().replace(/[^\w.-]+/g, '-');
    else if (arg === '--source') a.source = resolve(next());
    else if (arg === '--keep-worktree') a.keepWorktree = true;
    else if (arg === '--refresh-ticket') a.refreshTicket = true;
    else if (/^\d+$/.test(arg)) a.iid = Number(arg);
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  if (!a.iid) throw new Error(USAGE);
  a.source ??= join(ROOT, 'state', 'runs', String(a.iid));
  return a as Args;
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const args = parseArgs(process.argv.slice(2));
const sourceJournal = readJson<{ url?: string; branch?: string; createdAt?: number; runId: string; phases?: PhaseRow[] }>(
  join(args.source, 'run.json'),
);
const project = sourceJournal.url?.split('/-/')[0];
if (!project) throw new Error(`${args.source}/run.json has no ticket url to take the project from`);

// The source testcases.json, read BEFORE the scratch run dir is wiped, since it
// is the list this verify replay must grade against.
const sourceTestcasesPath = join(args.source, 'testcases.json');
const sourceTestcases = existsSync(sourceTestcasesPath) ? readFileSync(sourceTestcasesPath, 'utf8') : null;
if (!sourceTestcases) throw new Error(`${sourceTestcasesPath} is missing: verify has no case list to replay`);

// Before ANY import that reaches src/lib/config.ts: all three are read once, at load.
process.env.DRY_RUN = '1';
process.env.GITLAB_REPO_URL = project;
process.env.ONESHOT_SKILLS_ROOT = join(ROOT, 'context');

const { phaseByName, runDir, scopedEnvName, WORK_REPO, PROJECT_TARGET } = await import('../src/lib/config.js');
const { transcriptPath } = await import('../src/lib/artifacts.js');
const { fetchTicket } = await import('../src/conductor/runner.js');
const { runPhase } = await import('../src/conductor/phase.js');
const { promptFor, systemPromptFor } = await import('../src/phases/prompts.js');
const {
  answerKeyCommits, replayWorktree, removeReplayWorktree, leasePortFor, releasePort, reapPortServer,
} = await import('../src/lib/worktrees.js');
type RunJournal = import('../src/lib/artifacts.js').RunJournal;
type Ticket = import('../src/phases/types.js').Ticket;
type TicketDoc = import('../src/phases/types.js').TicketDoc;

const git = (argv: string[]): string => execFileSync('git', argv, { cwd: WORK_REPO, encoding: 'utf8' }).trim();

const origin = existsSync(WORK_REPO) ? git(['remote', 'get-url', 'origin']) : '';
if (repoKey(origin) !== repoKey(project)) {
  throw new Error(`#${args.iid} is a ${project} ticket, but the work repo ${WORK_REPO || '(unset)'} is `
    + `${origin || 'missing'}. Set ${scopedEnvName('WORK_REPO')} and ${scopedEnvName('WT_ROOT')} in .env.`);
}

const verifyStart = (sourceJournal.phases ?? [])
  .find((p) => p.phase === 'verify' && p.lap === 0)?.startedAt;
if (!verifyStart) throw new Error(`#${args.iid}: the run never started verify, so there is nothing to replay`);
if (!sourceJournal.branch) throw new Error(`#${args.iid}: the journal names no branch`);

/** The output of the last lap of `phase` that started before verify lap 0, from its transcript. */
function priorAt(phase: string): { data: Record<string, unknown> | null; fromArtifact: boolean } {
  const laps = (sourceJournal.phases ?? [])
    .filter((p) => p.phase === phase && (p.startedAt ?? Infinity) < verifyStart!)
    .map((p) => p.lap);
  const lap = laps.length ? Math.max(...laps) : null;
  const tee = lap === null ? '' : join(args.source, 'transcripts', `${phase}-lap${lap}.jsonl`);
  const output = tee && existsSync(tee) ? transcriptResult(readFileSync(tee, 'utf8')).output : null;
  if (output) return { data: output, fromArtifact: false };
  const artifact = join(args.source, `${phase}.json`);
  return { data: existsSync(artifact) ? readJson(artifact) : null, fromArtifact: true };
}

const branchRef = (() => {
  for (const ref of [sourceJournal.branch, `origin/${sourceJournal.branch}`]) {
    try { git(['rev-parse', '--verify', '--quiet', ref]); return ref; } catch { /* try the next spelling */ }
  }
  throw new Error(`branch ${sourceJournal.branch} is not in ${WORK_REPO}; fetch it first`);
})();
const sha = git(['rev-list', '-1', `--before=${Math.floor(verifyStart / 1000)}`, branchRef]);
if (!sha) throw new Error(`${branchRef} has no commit from before verify lap 0 started`);

const replayRoot = join(ROOT, 'state', 'replays', 'verify', PROJECT_TARGET, String(args.iid));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = join(replayRoot, `${stamp}-${args.label}`);
mkdirSync(outDir, { recursive: true });
rmSync(runDir(args.iid), { recursive: true, force: true });

// Seed the scratch run dir with the list to verify, where readArtifact() looks.
mkdirSync(runDir(args.iid), { recursive: true });
writeFileSync(join(runDir(args.iid), 'testcases.json'), sourceTestcases);

/** One `- \`name\` (where) — ...` line of the documents block back into a TicketDoc. */
function parseDoc(line: string): TicketDoc | null {
  const m = /^- `(.+?)` \((.+?)\) — (.*)$/.exec(line);
  if (!m) return null;
  const [, name, where, rest] = m as unknown as [string, string, string, string];
  const text = /^text: `(.+?)` \(original: `(.+?)`\)$/.exec(rest);
  if (text) return { name, where, textPath: text[1], path: text[2] };
  const failed = /^could not be read: (.*)$/.exec(rest);
  if (failed) return { name, where, error: failed[1] };
  const plain = /^`(.+?)`(?: \((.*)\))?$/.exec(rest);
  return plain ? { name, where, path: plain[1], ...(plain[2] ? { error: plain[2] } : {}) } : null;
}

/**
 * The ticket exactly as the live verify lap 0 session was shown it, parsed back
 * out of ticketBlock() in that session's own log under ~/.claude/projects.
 * Comments included are the ones that session saw, and it needs no GitLab. Null
 * when the log is gone or does not parse.
 */
function ticketFromTranscript(): Ticket | null {
  const tee = join(args.source, 'transcripts', 'verify-lap0.jsonl');
  const sid = existsSync(tee) ? /"session_id":"([^"]+)"/.exec(readFileSync(tee, 'utf8'))?.[1] : undefined;
  const projects = join(homedir(), '.claude', 'projects');
  const log = sid && readdirSync(projects).map((d) => join(projects, d, `${sid}.jsonl`)).find(existsSync);
  if (!log) return null;
  for (const line of readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const m = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
    if (m.type !== 'user') continue;
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : (c as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
    const head = /^## Ticket #(\d+) — (.*)\n.*\nLabels: (.*)\n\n### Description\n/.exec(text);
    if (!head || Number(head[1]) !== args.iid) return null;
    const block = text.slice(head[0].length).split('\n\n## Research (phase 1)')[0]!;
    const [main, ...docParts] = block.split(/\n\n### Documents (?=attached|linked)/);
    const cut = main!.search(/\n(?:### Comments \(\d+\)|\(no comments\))/);
    const body = cut >= 0 ? main!.slice(0, cut) : main!;
    const notes = cut >= 0 ? main!.slice(cut).split(/\n--- comment \d+ ---\n/).slice(1) : [];
    const docLines = (docParts.find((d) => d.startsWith('attached')) ?? '').split('\n');
    const extLines = (docParts.find((d) => d.startsWith('linked')) ?? '').split('\n');
    return {
      iid: args.iid, title: head[2]!,
      labels: head[3] === 'none' ? [] : head[3]!.split(', '),
      description: body.trim() === '(empty)' ? null : body,
      notes,
      documents: docLines.map(parseDoc).filter((d): d is TicketDoc => d !== null),
      externalDocs: extLines.map((l) => /^- (\S+) \((.+)\)$/.exec(l)).filter((x): x is RegExpExecArray => !!x)
        .map((x) => ({ url: x[1]!, where: x[2]! })),
    };
  }
  return null;
}

const ticketPath = join(replayRoot, `ticket-${sourceJournal.runId}.json`);
let ticket: Ticket;
let ticketSource: 'cache' | 'transcript' | 'gitlab';
if (existsSync(ticketPath) && !args.refreshTicket) {
  ticket = readJson<Ticket>(ticketPath);
  ticketSource = 'cache';
} else {
  const seen = ticketFromTranscript();
  const fetched = seen ?? await fetchTicket(args.iid, { notesBefore: sourceJournal.createdAt });
  if (!fetched) throw new Error(`could not read ticket #${args.iid}: no verify session log, and ${project} did not answer`);
  ticket = fetched;
  ticketSource = seen ? 'transcript' : 'gitlab';
  writeFileSync(ticketPath, `${JSON.stringify(ticket, null, 2)}\n`);
}

const prior: Record<string, Record<string, unknown> | null> = {};
const priorFromArtifact: string[] = [];
for (const phase of PRIOR_PHASES) {
  const { data, fromArtifact } = priorAt(phase);
  prior[phase] = data;
  if (fromArtifact) priorFromArtifact.push(phase);
}

let answerKey: string[] | null;
try { answerKey = answerKeyCommits(args.iid, sha); } catch { answerKey = null; }

const oneshotSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const runId = `replay-verify-${args.iid}-${stamp}`;
const worktree = replayWorktree(runId, sha);
const port = leasePortFor(runId);
if (port === null) throw new Error('no port free in the pool; stop another run or wait for one to release');
const journal = {
  runId, iid: args.iid, title: ticket.title, url: sourceJournal.url, createdAt: Date.now(),
  status: 'running', phases: [], port,
} as unknown as RunJournal;

console.log(`replay    verify #${args.iid} (${PROJECT_TARGET}) at ${sha.slice(0, 9)} on ${branchRef}, port ${port}`);
console.log(`oneshot   ${oneshotSha}   output ${outDir}`);
if (priorFromArtifact.length) console.log(`prior     from the final artifact, not the lap before verify: ${priorFromArtifact.join(', ')}`);
if (answerKey?.length) console.log(`NOT BLIND ${answerKey.length} later commit(s) naming #${args.iid} are reachable from the worktree`);

const meta: Record<string, unknown> = {
  iid: args.iid, project, label: args.label, oneshot: oneshotSha, sha, branch: branchRef, port,
  sourceRun: sourceJournal.runId, ticketSource, priorFromArtifact, answerKeyCommits: answerKey,
};
let exitCode = 0;
try {
  const cfg = phaseByName('verify');
  if (!cfg) throw new Error('config/phases.json has no verify phase');
  const ctx = { ticket, runId, lap: 0, worktree, branch: sourceJournal.branch, journal, prior };
  const started = Date.now();
  const out = await runPhase({
    iid: args.iid, runId, lap: 0, cfg,
    prompt: promptFor(cfg, ctx), systemPrompt: systemPromptFor(cfg, ctx), worktree, port,
    branch: sourceJournal.branch,
  });
  const tee = transcriptPath(args.iid, 'verify', 0);
  const text = existsSync(tee) ? readFileSync(tee, 'utf8') : '';
  if (text) copyFileSync(tee, join(outDir, 'verify.jsonl'));
  copyFileSync(join(runDir(args.iid), 'testcases.json'), join(outDir, 'testcases.json'));
  Object.assign(meta, {
    ok: out.ok, turns: out.turns, costUsd: transcriptResult(text).costUsd,
    minutes: Math.round((Date.now() - started) / 6000) / 10, infra: out.infra ?? false,
    skillsInvoked: skillsInvoked(text), blocked: out.blocked, error: out.error,
  });
  console.log(`verify    ${out.ok ? 'ok' : 'FAILED'} · ${out.turns} turns`);
  const data = out.data ?? (existsSync(join(runDir(args.iid), 'verify.json'))
    ? readJson(join(runDir(args.iid), 'verify.json')) : null);
  if (out.ok && data) writeFileSync(join(outDir, 'verify.json'), `${JSON.stringify(data, null, 2)}\n`);
  else exitCode = 1;
} finally {
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  releasePort(runId);
  reapPortServer(port);
  if (!args.keepWorktree) removeReplayWorktree(worktree);
}
console.log(`OUTPUT ${outDir}`);
process.exit(exitCode);

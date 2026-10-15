/**
 * The local automation tests mode: scan, state machine, and the scope session.
 *
 * A third, independent mode in the same conductor process, beside the Loop and
 * the Ready For Automation mode, and modelled on the latter. It runs AFTER the
 * merge, never inside the Loop: the Loop ends at the merge, and the code worth
 * testing against workstream-automation is what actually landed.
 *
 * The flow, one ticket at a time:
 *
 *   1. START when the ticket carries `Ready for Automation Testing` AND a merge
 *      request linked to it is merged into the base branch and is its real
 *      change, not a promotion (hooks/local-tests-ready.cjs). Labelled but not
 *      merged is a quiet wait, re-checked on later ticks. Any assignee.
 *   2. SCOPE: a read-only ERP checkout at the merge commit, a throwaway
 *      automation worktree, and ONE `local-tests-scope` session that picks the
 *      specs. Its edits are captured as a patch and both checkouts removed.
 *      With no spec reaching the change it writes nothing of its own: the list
 *      comes back empty with a suggested test.
 *   3. ASK: one note, the list (or "none found") with QA @mentioned. QA
 *      approves EVERY local run.
 *   4. QA's first decisive reply after the note: `approved` runs the list (or,
 *      with nothing found, marks the ticket done without local tests);
 *      `disapproved:` asks to check master again (a deterministic re-check, no
 *      session), names added files (looked up on the automation ref), asks for
 *      a temporary test, or says what to change (both a new scope session).
 *   5. RUN: scripts/localtests.cjs against the merge commit, under the desk's
 *      Cypress lease; a busy desk parks.
 *   6. RESULTS on the ticket, and the ticket marked `Automation Testing Done`
 *      whether the tests passed or failed. A run that could not happen puts the
 *      trigger back, says why, and puts the list to QA again.
 *
 * What it never touches, by construction: the Loop's run journal and claim
 * table, the port pool and the `running` map. Its own state is
 * STATE/localtests/<iid> (journal.ts). The one directory it shares with the
 * Loop is state/runs/<iid>, because scripts/localtests.cjs keys every resource
 * by it (the throwaway worktrees, the patch, the run's artifacts) and the scope
 * session's write scope is that directory; nothing here reads or writes the
 * Loop's run.json there.
 *
 * The shape of every function follows from the Ready For Automation mode's
 * three rules (src/automation/runner.ts):
 *
 * 1. The journal is the local source of truth, and each tick recomputes the
 *    next step from it and the scanned issue (`nextStep`, pure).
 * 2. Every GitLab write is marker-checked first: each post carries a marker
 *    naming its purpose and this journal's run id, so a crash between a post
 *    and the journal write adopts the note instead of repeating it, and a new
 *    request (a new run id) never adopts an earlier request's notes.
 * 3. `advanceTicket` keeps stepping until it reaches a waiting point, so in
 *    DRY_RUN a whole ticket goes through in one pass.
 *
 * DRY_RUN: every GitLab write is logged and kept under the dry-run home's
 * STATE/localtests/<iid>/dry-run/, never made — this file refuses them itself,
 * before gitlab.ts would. QA's approval is assumed. Cypress is skipped unless
 * ONESHOT_LOCAL_TESTS_DRY_CYPRESS=1, when the run really happens locally (a
 * database copy, the app, Cypress) and still writes nothing to GitLab. The
 * scope session does run, without write tools, as every dry-run session does.
 *
 * Every external effect goes through ModeDeps, so the tests drive whole
 * tickets with a fake GitLab, a fake session and a fake script.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  DRY_RUN, PAUSE, ROOT, WORK_REPO, envFlag, localTestsConfig, phaseByName, projectConfig, reviewersConfig, runDir,
  type LocalTestsConfig,
} from '../lib/config.js';
import { currentProjectKey } from '../lib/journalproject.js';
import {
  addIssueNote, allIssueNotes, editIssueLabels, getIssue, issueNotes, issuesWithLabel, uploadFile,
  type GitlabResult, type Issue, type IssueNote, type Upload,
} from '../lib/gitlab.js';
import { readArtifact, writeArtifact, type RunJournal } from '../lib/artifacts.js';
import { isMachineNote } from '../lib/claims.js';
import { codeSpan } from '../lib/gitlabmd.js';
import { MAX_UPLOAD_BYTES, mimeFor } from '../lib/publish.js';
import { activeRunsFleet, logEvent } from '../lib/db.js';
import { log } from '../lib/log.js';
import { checkQuota, quotaParked } from '../lib/quota.js';
import { isReachable } from '../lib/reachability.js';
import { alert } from '../lib/slack.js';
import { accountActionReason } from '../lib/accountgate.js';
import { ensureClaudeDir } from '../lib/claudedir.js';
import { detachTrackedClaude } from '../lib/worktrees.js';
import {
  CANCELLED_BY_CONDUCTOR, NO_STRUCTURED_OUTPUT, runPhase, type PhaseInput, type PhaseOutput,
} from '../conductor/phase.js';
import { repliesAfter } from '../conductor/reviewgate.js';
import {
  RUN_ARTIFACT, SCOPE_ARTIFACT, captureOf, captureScope, captureScopeSession, cliErrorText, gcLocalTests,
  notRunnableOf, parseCliObject, prepareScope, prepareScopeAt, runApprovedTests, specFiles, weakenedFiles,
  type CliResult, type LocalTestsDeps, type ScopeInputs,
} from '../conductor/localtests.js';
import { promptFor, systemPromptFor, type PromptCtx } from '../phases/prompts.js';
import type { LocalTestsRun, Ticket } from '../phases/types.js';
import {
  localTestsApprovedWithoutTestsNote, localTestsFoundNote, localTestsNotFoundNote, localTestsRecheckNote,
  localTestsResultsNote, localTestsSetupErrorNote, localTestsStuckNote,
  type Attachment, type LocalTestsNote, type LocalTestsNoteInfo,
} from './messages.js';
import { classifyLocalTestsReply, type LocalTestsReply } from './replies.js';
import {
  acquireLtLock, archiveLtJournal, erpCheckoutDir, heldLtIids, keepPatch, listLtJournals, localTestsDir, localTestsHome,
  newLtJournal, readList, readLtJournal, readRunRecord, saveList, saveRunRecord, writeLtJournal,
  type ListRecord, type LocalTestsJournal, type LocalTestsState, type MergedRange, type MergedRef,
} from './journal.js';
import { checkLocalTestsReady, type LocalTestsReadiness, type ReadyInputs } from './readiness.js';

const execFileP = promisify(execFile);

/** The one session this mode runs. On demand in config/phases.json: the Loop never schedules it. */
export const SCOPE_PHASE = 'local-tests-scope';

/** Charged scope failures in a row before the ticket is `stuck`. */
export const MAX_SCOPE_ATTEMPTS = 2;

/** Uncharged failures in a row before one attempt is charged anyway. */
const FREE_RETRY_CAP = 3;

/** More steps than any real path takes (a dry run end to end is eight): a bug cannot spin a tick. */
const MAX_STEPS = 16;

/**
 * A labelled ticket whose change is not merged yet is asked again this often,
 * or as soon as the ticket changes: a merge does not touch the ticket, and the
 * question costs three GETs.
 */
export const RECHECK_MS = 5 * 60_000;

/**
 * Another request's notes on the ticket, with no results after them, mean
 * another desk is advancing it — unless its newest note is older than this,
 * when it is a request nobody finished (a journal lost to a crash, say), and
 * this desk goes ahead.
 */
export const OTHER_DESK_STALE_MS = 7 * 24 * 60 * 60_000;

/** The analysis script answers in about a second; this is for a huge diff on a slow disk. */
const IMPACT_MS = 2 * 60_000;
/** A fetch of the ERP or automation clone. */
const FETCH_MS = 3 * 60_000;
/** A `git worktree add` of the whole ERP at one commit. */
const CHECKOUT_MS = 5 * 60_000;

const IMPACT_SCRIPT = join(ROOT, 'skills', 'local-tests-impact', 'scripts', 'index.cjs');

// ------------------------------------------------------------------ the deps

/** The parts of the analysis script's answer this mode reads. */
export interface ImpactSpec { file: string; module?: string; its?: number; ciSeconds?: number | null; reasons: string[] }
export interface ImpactAnalysis { specs: ImpactSpec[]; totals?: { its?: number; estimatedMinutes?: number } }

/**
 * Every effect the mode has, injectable. The defaults are the real ones; a
 * test replaces what it needs and the rest stays out of its reach only if it
 * replaces it, so the tests replace all of GitLab, the session and the script.
 */
export interface ModeDeps {
  dryRun: boolean;
  /** DRY_RUN only: run Cypress anyway (ONESHOT_LOCAL_TESTS_DRY_CYPRESS=1). */
  dryCypress: boolean;
  config(): LocalTestsConfig;
  /** config/reviewers.json `qa`: who may answer the list. */
  qa(): string[];
  /** branches.base: the branch a change must be merged into. */
  baseBranch(): string;
  /** The ERP clone every checkout and run is cut from (WORK_REPO). */
  workRepo: string;
  gitlab: {
    getIssue(iid: number): Promise<GitlabResult<Issue>>;
    notes(iid: number): Promise<GitlabResult<IssueNote[]>>;
    addNote(iid: number, body: string): Promise<GitlabResult<{ id: number }>>;
    upload(name: string, content: Buffer | string, mime: string): Promise<GitlabResult<Upload>>;
    editLabels(iid: number, change: { add?: string[]; remove?: string[] }): Promise<GitlabResult<Issue>>;
    /** Tickets carrying the trigger label, open or closed. */
    scan(trigger: string): Promise<GitlabResult<Issue[]>>;
  };
  readiness(iid: number, o: ReadyInputs): Promise<LocalTestsReadiness>;
  ticket(iid: number): Promise<Ticket | null>;
  /** `git <args>` in `cwd`, trimmed stdout. Throws on a non-zero exit. */
  git(args: string[], cwd: string, timeoutMs?: number): Promise<string>;
  session(input: PhaseInput): Promise<PhaseOutput>;
  /** skills/local-tests-impact/scripts/index.cjs with these arguments: its one JSON object. */
  impact(args: string[]): Promise<CliResult<Record<string, unknown>>>;
  /** The read-only ERP checkout a scope session reads. */
  erp: { add(dir: string, sha: string): Promise<void>; remove(dir: string): Promise<void> };
  /** scripts/localtests.cjs and the lease, as src/conductor/localtests.ts takes them. */
  lt: Partial<LocalTestsDeps>;
  /** Why no session may start now (usage limit, budget), or null. */
  sessionHold(runId: string, lap: number): string | null;
  /** A Loop run of this ticket is in flight on this desk: its run directory is in use. */
  loopBusy(iid: number): boolean;
  /** The network breaker's word: false holds the whole pass. */
  reachable(): boolean;
  event(kind: string, detail: Record<string, unknown>, runId?: string): void;
  alert(text: string): Promise<void>;
}

/**
 * `git -C <cwd> <args>`, never waiting on a person: no terminal prompt, and an
 * SSH that fails rather than asks (the setting scripts/localtests.cjs fetches
 * with), so a fetch on a desk whose key is locked is an error, not a hang.
 */
async function gitIn(args: string[], cwd: string, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env, GIT_TERMINAL_PROMPT: '0', HUSKY: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15',
    },
  });
  return stdout.trim();
}

/** The ticket as the scope prompt reads it: the description and the human comments, nothing a machine posted. */
async function fetchTicket(iid: number): Promise<Ticket | null> {
  const res = await getIssue(iid);
  if (!res.ok || !res.data) return null;
  const notes = await allIssueNotes(iid);
  const comments = notes.ok && notes.data
    ? notes.data.filter((n) => !n.system && n.body && !isMachineNote(n.body) && !n.body.startsWith('Oneshot ')).map((n) => n.body)
    : [];
  return { iid: res.data.iid, title: res.data.title, description: res.data.description, labels: res.data.labels, notes: comments };
}

async function runImpact(args: string[]): Promise<CliResult<Record<string, unknown>>> {
  try {
    const { stdout } = await execFileP(process.execPath, [IMPACT_SCRIPT, ...args], {
      timeout: IMPACT_MS, maxBuffer: 64 * 1024 * 1024,
    });
    const obj = parseCliObject(stdout);
    return obj ? { ok: true, data: obj } : { ok: false, error: { code: 'E_BAD_OUTPUT', message: 'the analysis script printed no JSON object' } };
  } catch (err) {
    // A named failure exits 1 with {code, message, hint} on stdout.
    const obj = parseCliObject(String((err as { stdout?: unknown }).stdout ?? ''));
    if (obj && typeof obj.code === 'string') {
      return {
        ok: false,
        error: { code: obj.code, message: String(obj.message ?? ''), ...(typeof obj.hint === 'string' && obj.hint ? { hint: obj.hint } : {}) },
      };
    }
    return { ok: false, error: { code: 'E_IMPACT', message: `the analysis script failed: ${(err as Error).message.slice(0, 200)}` } };
  }
}

/**
 * Remove a checkout this mode made: through git first, so the clone forgets
 * it, then by hand — but only inside STATE/localtests, the one place this mode
 * puts checkouts, so a wrong path can never delete anything else.
 */
async function removeCheckout(dir: string, repo: string): Promise<void> {
  if (existsSync(dir)) {
    try { await gitIn(['worktree', 'remove', '--force', '--force', dir], repo); } catch { /* by hand below */ }
  }
  const home = resolve(localTestsHome());
  if (existsSync(dir) && resolve(dir).startsWith(`${home}${sep}`)) rmSync(dir, { recursive: true, force: true });
  try { await gitIn(['worktree', 'prune'], repo); } catch { /* best effort */ }
}

let accountHeld: string | null = null;

export function defaultModeDeps(): ModeDeps {
  return {
    dryRun: DRY_RUN,
    dryCypress: DRY_RUN && envFlag('ONESHOT_LOCAL_TESTS_DRY_CYPRESS'),
    config: () => localTestsConfig(),
    qa: () => reviewersConfig().qa,
    baseBranch: () => projectConfig().branches.base || 'dev',
    workRepo: WORK_REPO,
    gitlab: {
      getIssue,
      notes: issueNotes,
      addNote: addIssueNote,
      upload: uploadFile,
      editLabels: editIssueLabels,
      scan: (trigger) => issuesWithLabel([trigger], { state: 'all' }),
    },
    readiness: (iid, o) => checkLocalTestsReady(iid, o),
    ticket: fetchTicket,
    git: gitIn,
    session: runPhase,
    impact: runImpact,
    erp: {
      add: async (dir, sha) => {
        await removeCheckout(dir, WORK_REPO);
        mkdirSync(join(dir, '..'), { recursive: true });
        await gitIn(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', dir, sha], WORK_REPO, CHECKOUT_MS);
        // The skills the session reads come from a composed .claude in its
        // cwd — an upgrade, never a dependency: the prompt carries the method.
        // Only the skills: the session reads this checkout and never runs the
        // app, so it gets none of the seed's node_modules, venv or settings.
        try {
          detachTrackedClaude(dir);
          ensureClaudeDir(dir);
        } catch (err) {
          log.warn(`local      could not compose the skills in ${dir}: ${(err as Error).message}`);
        }
      },
      remove: (dir) => removeCheckout(dir, WORK_REPO),
    },
    lt: {},
    sessionHold: (runId, lap) => {
      if (quotaParked()) return 'parked after a subscription usage limit';
      if (accountHeld) return 'the Claude account needs a one-time action (see the alert); restart once it is done';
      const q = checkQuota(runId, SCOPE_PHASE, lap);
      return q.allowed ? null : q.reason ?? 'over budget';
    },
    loopBusy: (iid) => activeRunsFleet().some((r) => r.iid === iid),
    reachable: isReachable,
    event: (kind, detail, runId) => logEvent(kind, detail, { runId, phase: SCOPE_PHASE }),
    alert: async (text) => {
      try { await alert(text); } catch (err) { log.error(`[alert failed] ${text}`, { error: (err as Error).message }); }
    },
  };
}

function withModeDefaults(over: Partial<ModeDeps> = {}): ModeDeps {
  const d = defaultModeDeps();
  return { ...d, ...over, gitlab: { ...d.gitlab, ...over.gitlab }, erp: { ...d.erp, ...over.erp } };
}

/** The script's deps as this mode runs them: its dry-run switch is the mode's unless a test says otherwise. */
function ltDeps(deps: ModeDeps): Partial<LocalTestsDeps> {
  return { dryRun: deps.dryRun, ...deps.lt };
}

// ------------------------------------------------------------------ outcomes

export interface LocalTestsOpts {
  conductor: string;
  signal: AbortSignal;
  /** `--assume-label`: treat the trigger as present. Only ever set with DRY_RUN (src/index.ts refuses it otherwise). */
  assumeLabel?: boolean;
  /** Whether the operator has paused this machine. Default: state/PAUSE exists. */
  paused?: () => boolean;
  deps?: Partial<ModeDeps>;
}

export interface LocalTestsOutcome { iid: number; state: LocalTestsState | 'skipped'; did: string }

/** The line `--local-tests <iid>` ends on, the state said once. */
export function outcomeLine(o: LocalTestsOutcome): string {
  const state = o.state.replace(/-/g, ' ');
  const said = new RegExp(`^${state}(?![\\w-])`, 'i').test(o.did);
  return `local      #${o.iid} ${said ? o.did : `${o.state} — ${o.did}`}`;
}

function tag(iid: number): string {
  return `local      #${iid}`;
}

function isPaused(opts: LocalTestsOpts): boolean {
  return opts.paused ? opts.paused() : existsSync(PAUSE);
}

// ------------------------------------------------------------------ the state machine

export type Step =
  | { kind: 'skip'; why: string }
  | { kind: 'hold'; why: string }
  | { kind: 'check'; reason: 'first' | 'changed' | 'cadence' }
  | { kind: 'scope'; request: 'first' | 'write-temporary' | 'feedback' }
  | { kind: 'recheck' }
  | { kind: 'add' }
  | { kind: 'post'; round: number }
  | { kind: 'review' }
  | { kind: 'start' }
  | { kind: 'run' }
  | { kind: 'report' }
  | { kind: 'restore' }
  | { kind: 'stuck-poll' };

export interface StepOpts {
  labels: { trigger: string; running: string; done: string };
  project: string | null;
  now: number;
  recheckMs: number;
  assumeLabel?: boolean;
}

function latestList(j: Pick<LocalTestsJournal, 'lists'>): ListRecord | undefined {
  return j.lists[j.lists.length - 1];
}

/**
 * Pure. What to do next, from the journal and the ticket's labels.
 *
 * Order: done → skip. The writes an approval already set in motion come next,
 * whatever the labels say now, because the label edits are this mode's own:
 * a `reporting` run owes its results, a `setup-error` its restore, a
 * `running` list its run, an approval whose done labels are on owes its
 * record, and an approval whose start label edit was sent without an answer
 * (`pendingLabels` — that edit takes the trigger off itself) owes finishing
 * it. Everything else needs the trigger (or `--assume-label`): no trigger
 * is a silent skip, journal kept. Then first sight → check; waiting → check on
 * change or cadence, else hold; stuck → stuck-poll; an unposted list → post;
 * then the state's own step.
 *
 * A journal stamped for another project is read as no journal: iids are unique
 * only within a project (advanceTicket moves it aside first).
 */
export function nextStep(
  j: LocalTestsJournal | null, issue: Pick<Issue, 'labels' | 'updated_at'>, o: StepOpts,
): Step {
  const jj = j && j.project === o.project ? j : null;
  const labels = issue.labels ?? [];
  const triggered = Boolean(o.assumeLabel) || labels.includes(o.labels.trigger);
  if (jj?.state === 'done') {
    return {
      kind: 'skip',
      why: labels.includes(o.labels.done)
        ? `already ${o.labels.done} — nothing to do`
        : `finished earlier — put "${o.labels.trigger}" back on the ticket to run it again`,
    };
  }
  if (jj?.state === 'reporting') return { kind: 'report' };
  if (jj?.state === 'setup-error') return { kind: 'restore' };
  if (jj?.state === 'running') return { kind: 'run' };
  if (jj?.state === 'approved' && (jj.labelsDone || jj.pendingLabels)) return { kind: 'start' };
  if (!triggered) return { kind: 'skip', why: `no "${o.labels.trigger}" label` };
  if (!jj || jj.state === 'new') return { kind: 'check', reason: 'first' };

  if (jj.state === 'waiting') {
    const r = jj.readiness;
    if (!r) return { kind: 'check', reason: 'first' };
    if (r.issueUpdatedAt !== issue.updated_at) return { kind: 'check', reason: 'changed' };
    if (o.now - r.at >= o.recheckMs) return { kind: 'check', reason: 'cadence' };
    const next = new Date(r.at + o.recheckMs).toISOString().slice(11, 16);
    return { kind: 'hold', why: `waiting for the change to be merged (${r.reason}) — next check when the ticket changes, or at ${next} UTC` };
  }
  if (!jj.merged) return { kind: 'check', reason: 'first' };
  if (jj.state === 'stuck') return { kind: 'stuck-poll' };

  const latest = latestList(jj);
  if (latest && latest.postedAt === null) return { kind: 'post', round: latest.round };
  switch (jj.state) {
    case 'scoping': return { kind: 'scope', request: jj.request?.kind ?? 'first' };
    case 'rechecking': return { kind: 'recheck' };
    case 'adding': return jj.addFiles ? { kind: 'add' } : { kind: 'review' };
    case 'awaiting-qa': return latest ? { kind: 'review' } : { kind: 'scope', request: 'first' };
    case 'approved': return { kind: 'start' };
    default: return { kind: 'hold', why: `the journal is in an unknown state '${String(jj.state)}'` };
  }
}

/**
 * Pure. The first decision among the replies to the latest list: human, after
 * the list's note and after every reply already consumed, from a QA reviewer,
 * and not one of the Loop's unmarked `Oneshot …` notes (the desk's token may
 * belong to a QA reviewer). A reply that carries no decision ("looking at it",
 * "Approved.") is passed over, not read as one; replies from anyone else are
 * ignored. Null: keep waiting.
 */
export function qaDecision(
  notes: IssueNote[], o: { since: number; qa: string[] },
): { reply: LocalTestsReply; id: number; by: string; at: string } | null {
  for (const r of repliesAfter(notes, o.since)) {
    if (r.text.startsWith('Oneshot ') || r.user === null || !o.qa.includes(r.user)) continue;
    const reply = classifyLocalTestsReply(r.text);
    if (reply) return { reply, id: r.id, by: r.user, at: r.at ?? '' };
  }
  return null;
}

/** A note of another Oneshot mode or of the Loop: any `<!-- oneshot:` marker but this mode's own. */
const FOREIGN_MARKER_RE = /<!--\s*oneshot:(?!local-tests)/i;

/**
 * Pure. Another Oneshot request posted after this mode's list and before a QA
 * reply, or null. The notes carry no thread, so a bare `approved` after, say,
 * the Ready For Automation mode's cases cannot be told apart from one for this
 * list; it is not read as a decision for either.
 */
export function foreignRequestBetween(notes: IssueNote[], after: number, before: number): IssueNote | null {
  return notes.find((n) => !n.system && n.id > after && n.id < before && FOREIGN_MARKER_RE.test(n.body ?? '')) ?? null;
}

/** This mode's post marker, read back: what the post was for, and whose run it belongs to. */
const POST_MARKER_RE = /<!--\s*oneshot:local-tests:post:([^:\s]+):(\S+?)\s*-->/g;

/** The posts a request ends on: the results, or the record of going on without tests. */
const FINISHING_KEY_RE = /^(?:results-|approved-without-tests$)/;

/**
 * Pure. The run id of another request still under way on the ticket, or null:
 * one whose posts are there and whose finishing post (the results, or the
 * record of going on without tests) is not, and whose newest post is newer
 * than OTHER_DESK_STALE_MS. The per-ticket lock is a local file, so this is
 * the only sign that another desk is advancing the ticket.
 */
export function otherDeskRun(notes: IssueNote[], runId: string, now: number): string | null {
  const runs = new Map<string, { finished: boolean; newest: number; newestAt: number }>();
  for (const n of notes) {
    if (n.system) continue;
    for (const m of (n.body ?? '').matchAll(POST_MARKER_RE)) {
      const key = m[1]!;
      const id = m[2]!;
      if (id === runId) continue;
      const r = runs.get(id) ?? { finished: false, newest: 0, newestAt: Number.NaN };
      if (FINISHING_KEY_RE.test(key)) r.finished = true;
      if (n.id > r.newest) {
        r.newest = n.id;
        r.newestAt = n.created_at ? Date.parse(n.created_at) : Number.NaN;
      }
      runs.set(id, r);
    }
  }
  let best: { id: string; newest: number } | null = null;
  for (const [id, r] of runs) {
    if (r.finished) continue;
    if (Number.isFinite(r.newestAt) && now - r.newestAt > OTHER_DESK_STALE_MS) continue;
    if (!best || r.newest > best.newest) best = { id, newest: r.newest };
  }
  return best?.id ?? null;
}

/**
 * Pure. The specs the deterministic re-check counts as found: those the
 * analysis reached through something the change itself touched — a page object
 * selecting a changed testid, a changed screen — never through their folder
 * alone (`module …`), which is a health check, not a test of the change.
 */
export function foundSpecs(analysis: Record<string, unknown> | null | undefined): ImpactSpec[] {
  const specs = Array.isArray(analysis?.specs) ? analysis.specs as unknown[] : [];
  const out: ImpactSpec[] = [];
  for (const s of specs) {
    if (!s || typeof s !== 'object') continue;
    const x = s as Record<string, unknown>;
    const reasons = Array.isArray(x.reasons) ? x.reasons.filter((r): r is string => typeof r === 'string') : [];
    if (typeof x.file !== 'string' || !reasons.some((r) => !r.startsWith('module '))) continue;
    if (out.some((o) => o.file === x.file)) continue;
    out.push({
      file: x.file, reasons,
      ...(typeof x.module === 'string' ? { module: x.module } : {}),
      ...(typeof x.its === 'number' ? { its: x.its } : {}),
      ...(typeof x.ciSeconds === 'number' ? { ciSeconds: x.ciSeconds } : {}),
    });
  }
  return out;
}

/** A spec path QA may name: under cypress/, a .ts or .js file, no `..`. */
export function isSpecPath(p: string): boolean {
  return /^cypress\/[\w.\-/]+\.(?:ts|js)$/.test(p) && !p.split('/').includes('..');
}

/**
 * Pure. Whether a session that produced no usable list is charged.
 * 'none' (cancelled, rate-limited) | 'account' | 'free' (died before reaching the model) | 'charge'.
 */
export function sessionCharge(out: PhaseOutput): 'none' | 'account' | 'free' | 'charge' {
  if (out.error === CANCELLED_BY_CONDUCTOR) return 'none';
  if (out.rateLimited) return 'none';
  if (out.accountAction) return 'account';
  if (out.infra && out.turns === 0 && out.weighted === 0) return 'free';
  return 'charge';
}

// ------------------------------------------------------------------ advancing

interface Ctx {
  iid: number;
  issue: Issue;
  opts: LocalTestsOpts;
  deps: ModeDeps;
  cfg: LocalTestsConfig;
  qa: string[];
  j: LocalTestsJournal | null;
}

type StepResult = { cont: true } | { cont: false; did: string };
const go: StepResult = { cont: true };
const stop = (did: string): StepResult => ({ cont: false, did });

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

const sha7 = (s: string | null | undefined): string => String(s ?? '').slice(0, 7);

/** The marker every post carries: what it is for, and the run it belongs to. */
export function postMarker(key: string, runId: string): string {
  return `<!-- oneshot:local-tests:post:${key}:${runId} -->`;
}

/**
 * DRY_RUN only: keep what a write would have carried, in full, under
 * STATE/localtests/<iid>/dry-run/ (STATE is the dry-run home), numbered in the
 * order the writes would have happened. Best effort.
 */
function keepDry(iid: number, name: string, content: string): string | null {
  try {
    const dir = join(localTestsDir(iid), 'dry-run');
    mkdirSync(dir, { recursive: true });
    const n = String(readdirSync(dir).length + 1).padStart(2, '0');
    const file = join(dir, `${n}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}`);
    writeFileSync(file, content);
    return file;
  } catch (err) {
    log.warn(`${tag(iid)} [dry-run] could not keep ${name}`, { error: errText(err) });
    return null;
  }
}

/**
 * A Slack alert — or, in DRY_RUN, a log line and a kept copy: src/lib/slack.ts
 * has no dry-run guard of its own, and a rehearsal must reach nobody.
 */
async function notify(ctx: Ctx, text: string): Promise<void> {
  if (ctx.deps.dryRun) {
    keepDry(ctx.iid, 'alert.txt', `${text}\n`);
    log.warn(`${tag(ctx.iid)} [dry-run] would alert: ${text}`);
    return;
  }
  await ctx.deps.alert(text);
}

/** notify() once per journal per key, recorded in the journal so a restart does not repeat it. */
async function alertOnce(ctx: Ctx, key: string, text: string): Promise<void> {
  const j = ctx.j!;
  j.alerted ??= [];
  if (j.alerted.includes(key)) return;
  j.alerted.push(key);
  writeLtJournal(j);
  await notify(ctx, text);
}

/**
 * Post a note unless one carrying the same marker is already among the newest
 * notes (a crash between an earlier post and its journal write). Attachments
 * are uploaded and linked under the body, as publish.ts does. In DRY_RUN
 * nothing is uploaded or posted: the note is logged and kept.
 */
async function postOnce(
  ctx: Ctx, key: string, note: LocalTestsNote, notes?: IssueNote[],
): Promise<{ ok: boolean; id: number | null; adopted: boolean; error?: string }> {
  const { iid, deps } = ctx;
  const marker = postMarker(key, ctx.j!.runId);
  let list = notes;
  if (!list) {
    const r = await deps.gitlab.notes(iid);
    if (!r.ok || !r.data) return { ok: false, id: null, adopted: false, error: `cannot read the ticket's notes (${r.kind})` };
    list = r.data;
  }
  const hit = list.find((n) => !n.system && (n.body ?? '').includes(marker));
  if (hit) return { ok: true, id: hit.id, adopted: true };

  if (deps.dryRun) {
    const names = note.attachments.map((a) => a.name);
    const file = keepDry(iid, `note-${key}.md`,
      `${note.body}${names.length ? `\n\n(attached: ${names.join(', ')})` : ''}\n${marker}\n`);
    log.info(`${tag(iid)} [dry-run] the ${key} note that would be posted${file ? ` (kept in ${file})` : ''}:\n${note.body}`);
    return { ok: true, id: null, adopted: false };
  }
  const links: string[] = [];
  for (const a of note.attachments) {
    const up = await deps.gitlab.upload(a.name, a.content, a.mime);
    if (up.ok && up.data) links.push(up.data.markdown);
    else log.warn(`${tag(iid)} could not attach ${a.name} (${up.kind})`);
  }
  const body = `${note.body}${links.length ? `\n\n${links.join('\n\n')}` : ''}\n\n${marker}`;
  const posted = await deps.gitlab.addNote(iid, body);
  if (!posted.ok) return { ok: false, id: null, adopted: false, error: `the post failed (${posted.kind} ${posted.status})` };
  return { ok: true, id: posted.data?.id ?? null, adopted: false };
}

/** One atomic label edit. In DRY_RUN it is logged and kept, never made. */
async function editLabels(ctx: Ctx, change: { add?: string[]; remove?: string[] }): Promise<boolean> {
  const { iid, deps } = ctx;
  if (deps.dryRun) {
    keepDry(iid, 'labels.json', `${JSON.stringify(change, null, 2)}\n`);
    log.warn(`${tag(iid)} [dry-run] would edit labels`, change);
    return true;
  }
  const res = await deps.gitlab.editLabels(iid, change);
  if (!res.ok) log.warn(`${tag(iid)} could not edit labels (${res.kind} ${res.status})`, change);
  return res.ok;
}

/** The silent stop for a withdrawn trigger: a log line and the outcome, nothing on the ticket. */
function withdrawnStop(ctx: Ctx): string {
  const label = ctx.cfg.labels.trigger;
  log.info(`${tag(ctx.iid)} "${label}" is not on the ticket — stopping, journal kept`);
  return `"${label}" is not on the ticket — stopped`;
}

/**
 * The trigger, read fresh, just before a write or a session that can come long
 * after the scan read it. null when it is on (or assumed); otherwise what the
 * step says. A failed read is a hold: nothing is written without seeing it.
 */
async function switchedOff(ctx: Ctx): Promise<string | null> {
  if (ctx.opts.assumeLabel) return null;
  const res = await ctx.deps.gitlab.getIssue(ctx.iid);
  if (!res.ok || !res.data) return `hold — cannot re-read the ticket's labels (${res.kind})`;
  return (res.data.labels ?? []).includes(ctx.cfg.labels.trigger) ? null : withdrawnStop(ctx);
}

/**
 * The merge commit in the ERP clone, and the commit before the change learned.
 * A merge the clone has not seen yet is fetched from origin's base branch
 * once; a clone that still cannot name it is a hold, tried again next tick.
 *
 * The base is readiness's when it named one (for a merge that made no merge
 * commit it is the MR's own base, where `^1` would be the MR's previous commit),
 * once the clone is seen to have it; otherwise the merge commit's first parent.
 */
async function ensureCommits(ctx: Ctx): Promise<{ ok: true; m: MergedRef & { base: string } } | { ok: false; did: string }> {
  const j = ctx.j!;
  const m = j.merged;
  if (!m) return { ok: false, did: 'hold — no merged MR is recorded' };
  const repo = ctx.deps.workRepo;
  const has = async (): Promise<boolean> => {
    try { await ctx.deps.git(['cat-file', '-e', `${m.mergeSha}^{commit}`], repo); return true; } catch { return false; }
  };
  if (!await has()) {
    try {
      await ctx.deps.git(['fetch', '--quiet', 'origin', ctx.deps.baseBranch()], repo, FETCH_MS);
    } catch (err) {
      log.warn(`${tag(ctx.iid)} could not fetch origin/${ctx.deps.baseBranch()} in ${repo}: ${errText(err).slice(0, 200)}`);
    }
    if (!await has()) {
      return { ok: false, did: `hold — the merge commit ${sha7(m.mergeSha)} is not in ${repo}, even after a fetch` };
    }
  }
  if (m.base && !m.baseChecked) {
    try {
      await ctx.deps.git(['cat-file', '-e', `${m.base}^{commit}`], repo);
      m.baseChecked = true;
    } catch {
      log.warn(`${tag(ctx.iid)} the base readiness named, ${sha7(m.base)}, is not in ${repo} — using the first parent of ${sha7(m.mergeSha)}`);
      m.base = null;
    }
  }
  if (!m.base) {
    try {
      m.base = await ctx.deps.git(['rev-parse', '--verify', `${m.mergeSha}^1`], repo);
    } catch (err) {
      return { ok: false, did: `hold — cannot read the first parent of ${sha7(m.mergeSha)}: ${errText(err).slice(0, 200)}` };
    }
    m.baseChecked = true;
    writeLtJournal(j);
  } else if (m.baseChecked) {
    writeLtJournal(j);
  }
  return { ok: true, m: m as MergedRef & { base: string } };
}

/** One change the analysis script reads: `base..head`, both in the ERP clone. */
interface Range { mrIid: number; base: string; head: string }

/**
 * The changes a scope or a re-check looks at. `own` is the tested MR's
 * (ensureCommits proved it). `earlier` is each other MR of the ticket's own
 * that readiness found merged, oldest first — a follow-up MR's merge is the
 * tested commit, but the change QA asked to test is the ticket's, all of it.
 * An earlier MR whose commits the clone cannot name is left out and returned
 * in `missed`, so the note can say it was not checked.
 */
async function rangesToScope(
  ctx: Ctx, m: MergedRef & { base: string },
): Promise<{ own: Range; earlier: Range[]; missed: number[] }> {
  const own: Range = { mrIid: m.mrIid, base: m.base, head: m.mergeSha };
  const listed = (m.ranges ?? []).filter((r) => r.head !== m.mergeSha && r.mrIid !== m.mrIid);
  const repo = ctx.deps.workRepo;
  const earlier: Range[] = [];
  const missed: number[] = [];
  const present = async (sha: string): Promise<boolean> => {
    try { await ctx.deps.git(['cat-file', '-e', `${sha}^{commit}`], repo); return true; } catch { return false; }
  };
  for (const r of listed) {
    try {
      if (!await present(r.head)) throw new Error(`${sha7(r.head)} is not in ${repo}`);
      const base = r.base && await present(r.base) ? r.base : await ctx.deps.git(['rev-parse', '--verify', `${r.head}^1`], repo);
      earlier.push({ mrIid: r.mrIid, base, head: r.head });
    } catch (err) {
      missed.push(r.mrIid);
      log.warn(`${tag(ctx.iid)} !${r.mrIid} is not checked — its commits cannot be read: ${errText(err).slice(0, 200)}`);
    }
  }
  return { own, earlier, missed };
}

/** The analysis script over one change, against the automation worktree at `wsa`. */
function analyse(ctx: Ctx, r: Range, wsa: string): Promise<CliResult<Record<string, unknown>>> {
  return ctx.deps.impact(['--erp', ctx.deps.workRepo, '--base', r.base, '--head', r.head, '--automation', wsa, '--json']);
}

/** `a`, `a and b`, `a, b and c`. */
function andList(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const mrList = (ns: number[]): string => andList(ns.map((n) => `!${n}`));

/**
 * What the notes call the change: the tested MR's title — and, when the ticket
 * has more than one of its own MRs merged, every other one the list was chosen
 * for. It reaches the notes as their `mrTitle`, which each of them prints as
 * "What changed".
 */
function changeTitle(m: MergedRef, rec: ListRecord): string {
  if ((m.ranges ?? []).length < 2) return m.title;
  const earlier = (rec.scopedMrs ?? [m.mrIid]).filter((n) => n !== m.mrIid);
  return `${m.title || `the change in !${m.mrIid}`}${earlier.length
    ? `, together with this ticket's earlier merged ${earlier.length === 1 ? 'MR' : 'MRs'} ${mrList(earlier)}` : ''}`;
}

/** The ticket's own merged MRs a list was NOT chosen for: their commits or their analysis could not be read. */
function unscopedMrs(m: MergedRef | undefined, rec: ListRecord): number[] {
  const all = (m?.ranges ?? []).map((r) => r.mrIid);
  if (!m || all.length < 2) return [];
  const scoped = rec.scopedMrs ?? [m.mrIid];
  return all.filter((n) => n !== m.mrIid && !scoped.includes(n));
}

/** What the found and not-found notes need besides the list. */
function noteInfo(ctx: Ctx, rec: ListRecord): LocalTestsNoteInfo {
  const m = ctx.j!.merged!;
  const title = changeTitle(m, rec);
  return {
    automationSha: rec.automationSha, mergeSha: m.mergeSha, mrIid: m.mrIid, qa: ctx.qa,
    ...(title ? { mrTitle: title } : {}),
    ...(rec.patchFile && rec.patchSha ? { patchFile: rec.patchFile } : {}),
  };
}

/**
 * The scope object a list was made from: the session's own for a scope list,
 * one written here for a re-check or QA's added files. Saved beside the
 * journal, and written as the run's local-tests-scope.json when the list runs,
 * so the report names the temporary changes that really ran.
 */
function listScope(rec: ListRecord, scope: Record<string, unknown> | null, why: (file: string) => string): Record<string, unknown> {
  if (rec.source === 'scope' && scope) return scope;
  const earlier = new Map(
    (Array.isArray(scope?.specs) ? scope.specs as Array<Record<string, unknown>> : [])
      .filter((s) => s && typeof s.file === 'string').map((s) => [s.file as string, s]),
  );
  return {
    applicable: rec.specs.length > 0,
    reason: typeof scope?.reason === 'string' ? scope.reason : '',
    modules: [],
    specs: rec.specs.map((file) => earlier.get(file) ?? { file, module: file.split('/')[2] ?? '', cases: 0, why: why(file) }),
    edits: rec.patchSha && Array.isArray(scope?.edits) ? scope.edits : [],
    proposals: [],
    notRunnable: rec.notRunnable,
    estimatedMinutes: rec.estimatedMinutes ?? 0,
    summary: '',
    ...(rec.patchSha && scope?.capture ? { capture: scope.capture } : {}),
  };
}

/**
 * Save a new list and put the ticket back to waiting on QA. The post step
 * follows. Its temporary changes are copied beside the journal first
 * (keepPatch): the scope saved them under state/runs/<iid>, which the Loop
 * archives whole if it claims the ticket again while the list waits on QA.
 */
function pushList(ctx: Ctx, rec: Omit<ListRecord, 'round' | 'noteId' | 'postedAt'>, scope: Record<string, unknown>): ListRecord {
  const j = ctx.j!;
  const round = (latestList(j)?.round ?? 0) + 1;
  let { patchFile } = rec;
  if (patchFile && rec.patchSha) {
    try {
      const kept = keepPatch(ctx.iid, round, patchFile);
      if (kept) patchFile = kept;
      else log.warn(`${tag(ctx.iid)} round ${round}'s temporary changes are not at ${patchFile}; a run of it will say so`);
    } catch (err) {
      log.warn(`${tag(ctx.iid)} could not copy round ${round}'s temporary changes beside the journal: ${errText(err)}`);
    }
  }
  const full: ListRecord = { ...rec, patchFile, round, noteId: null, postedAt: null };
  saveList(ctx.iid, round, scope);
  j.lists.push(full);
  j.state = 'awaiting-qa';
  writeLtJournal(j);
  return full;
}

// ----------------------------------------------------------------- the steps

/** A commit id as readiness hands it over: hex only, so it can never reach git as an option. */
function isSha(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{7,64}$/i.test(v);
}

/** Readiness's `ranges`, kept only where every field is what it should be. */
function rangesOf(v: unknown): MergedRange[] {
  if (!Array.isArray(v)) return [];
  const out: MergedRange[] = [];
  for (const r of v) {
    if (!r || typeof r !== 'object') continue;
    const x = r as Record<string, unknown>;
    if (typeof x.mrIid !== 'number' || !Number.isInteger(x.mrIid) || !isSha(x.head)) continue;
    if (out.some((o) => o.mrIid === x.mrIid)) continue;
    out.push({ mrIid: x.mrIid, base: isSha(x.base) ? x.base : null, head: x.head });
  }
  return out;
}

/** `check`: first sight, or a due re-check of a ticket whose change was not merged yet. */
async function stepCheck(ctx: Ctx, reason: 'first' | 'changed' | 'cadence'): Promise<StepResult> {
  const { iid, deps, cfg } = ctx;
  if (!ctx.j) {
    ctx.j = newLtJournal(iid, ctx.issue.title);
    writeLtJournal(ctx.j);
  }
  const j = ctx.j;
  const r = await deps.readiness(iid, { trigger: cfg.labels.trigger, base: deps.baseBranch(), assumeLabel: ctx.opts.assumeLabel });
  deps.event('local_tests_readiness', { iid, reason, verdict: r.verdict, mr: r.mergedMr?.iid ?? null }, j.runId);
  if (r.verdict === 'unknown') {
    log.warn(`${tag(iid)} hold — ${r.reason}`);
    if (r.errorKind === 'auth') {
      await alertOnce(ctx, 'auth', `Oneshot's local automation tests mode cannot read GitLab for #${iid}: ${r.error ?? 'the token was refused'}. `
        + 'A bad token never heals by waiting — fix GITLAB_READ_TOKEN or this desk\'s token.');
    }
    return stop(`hold — ${r.reason}`);
  }
  if (!r.labelled) return stop(withdrawnStop(ctx));
  if (!r.ready || !r.mergedMr) {
    const changed = j.readiness?.reason !== r.reason;
    j.state = 'waiting';
    j.readiness = { at: Date.now(), issueUpdatedAt: r.issueUpdatedAt ?? ctx.issue.updated_at, reason: r.reason };
    writeLtJournal(j);
    if (changed) log.info(`${tag(iid)} waiting — ${r.reason}; checked again later, nothing posted`);
    return stop(`waiting — ${r.reason}`);
  }
  const mr = r.mergedMr;
  const ranges = rangesOf(mr.ranges);
  j.merged = {
    mrIid: mr.iid, title: mr.title, mergeSha: mr.mergeSha, base: isSha(mr.base) ? mr.base : null,
    sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, author: mr.author, url: mr.url,
    ...(ranges.length > 1 ? { ranges } : {}),
  };
  delete j.readiness;
  j.state = 'scoping';
  writeLtJournal(j);
  log.info(`${tag(iid)} ready — ${r.reason}${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`);
  return go;
}

/** A charged scope failure. The second in a row makes the ticket `stuck`. */
async function charge(ctx: Ctx, reason: string): Promise<StepResult> {
  const j = ctx.j!;
  j.attempts += 1;
  j.freeRetries = 0;
  const short = reason.slice(0, 500);
  log.warn(`${tag(ctx.iid)} scope attempt ${j.attempts} of ${MAX_SCOPE_ATTEMPTS} failed: ${short}`);
  ctx.deps.event('local_tests_hold', { iid: ctx.iid, why: 'scope failed', attempts: j.attempts, reason: short }, j.runId);
  if (j.attempts < MAX_SCOPE_ATTEMPTS) {
    writeLtJournal(j);
    return stop(`scope attempt ${j.attempts} of ${MAX_SCOPE_ATTEMPTS} failed — retrying next tick: ${short}`);
  }
  const at = Date.now();
  j.state = 'stuck';
  j.stuck = { at, reason: short, fp: sha12(`${short}|${at}`), notePostedAt: null, sinceNoteId: null };
  writeLtJournal(j);
  await alertOnce(ctx, 'stuck', `Oneshot could not choose the local automation tests for #${ctx.iid} after `
    + `${MAX_SCOPE_ATTEMPTS} attempts: ${short}. No label was changed. Any comment from a QA reviewer on the ticket `
    + 'makes Oneshot try again.');
  return go;
}

/**
 * Before this request puts anything on the ticket: whether another request is
 * already under way there (otherDeskRun) — another desk, since this one's lock
 * would have stopped a second advance here. null: go on. Otherwise the stop
 * line, logged once per run id. A dry run writes nothing, so it is never held.
 */
async function otherDesk(ctx: Ctx, notes?: IssueNote[]): Promise<string | null> {
  const j = ctx.j!;
  if (ctx.deps.dryRun || j.lists.some((l) => l.postedAt !== null)) return null;
  let list = notes;
  if (!list) {
    const r = await ctx.deps.gitlab.notes(ctx.iid);
    if (!r.ok || !r.data) return `hold — cannot read the ticket's notes (${r.kind})`;
    list = r.data;
  }
  const other = otherDeskRun(list, j.runId, Date.now());
  if (!other) {
    if (j.otherDesk) {
      delete j.otherDesk;
      writeLtJournal(j);
    }
    return null;
  }
  if (j.otherDesk?.runId !== other) {
    j.otherDesk = { runId: other, at: Date.now() };
    writeLtJournal(j);
    log.info(`${tag(ctx.iid)} skipped — request ${other} has notes on the ticket and no results yet: another desk is `
      + 'advancing it (the per-ticket lock is local, so this mode runs on one desk)');
    ctx.deps.event('local_tests_other_desk', { iid: ctx.iid, other }, j.runId);
  }
  return `skipped — another desk's request (${other}) is under way on the ticket`;
}

/** An uncharged failure. Three in a row charge one attempt. */
async function freeRetry(ctx: Ctx, why: string): Promise<StepResult> {
  const j = ctx.j!;
  j.freeRetries += 1;
  if (j.freeRetries >= FREE_RETRY_CAP) {
    return charge(ctx, `${FREE_RETRY_CAP} sessions in a row ended before reaching the model (${why})`);
  }
  writeLtJournal(j);
  log.warn(`${tag(ctx.iid)} hold — ${why}; nothing charged (${j.freeRetries} of ${FREE_RETRY_CAP} in a row)`);
  return stop(`hold — ${why}; nothing charged`);
}

/** The next transcript lap for the scope session under state/runs/<iid>, so no transcript is ever appended to. */
function nextLap(iid: number): number {
  const dir = join(runDir(iid), 'transcripts');
  let max = -1;
  try {
    for (const f of readdirSync(dir)) {
      const m = new RegExp(`^${SCOPE_PHASE}-lap(\\d+)\\.jsonl$`).exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* no transcripts yet */ }
  return max + 1;
}

/**
 * The run's own record, as the prompts read it. This mode keeps no Loop
 * journal, so the scope session gets one that says only what is true: which
 * ticket, which run, and nothing done yet.
 */
function promptJournal(ctx: Ctx): RunJournal {
  const j = ctx.j!;
  return {
    runId: j.runId, iid: ctx.iid, title: j.title, url: ctx.issue.web_url, createdAt: j.createdAt,
    status: 'running', phases: [], ...(j.project ? { project: j.project } : {}),
  };
}

/** Release whatever the scope or re-check checked out, and clear it from the journal. */
async function releaseHolding(ctx: Ctx): Promise<void> {
  const j = ctx.j!;
  if (j.holding?.erp) await ctx.deps.erp.remove(j.holding.erp).catch((err: unknown) => {
    log.warn(`${tag(ctx.iid)} could not remove ${j.holding?.erp}: ${errText(err)} — gc will`);
  });
  delete j.holding;
  writeLtJournal(j);
}

/**
 * `scope`: the trigger read fresh, the merge commit in the clone, a read-only
 * ERP checkout at it and a throwaway automation worktree, then ONE session.
 * Both checkouts are gone again whatever it concluded.
 */
async function stepScope(ctx: Ctx, request: 'first' | 'write-temporary' | 'feedback'): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, deps } = ctx;
  const hold = deps.sessionHold(j.runId, j.sessions);
  if (hold) return stop(`hold — ${hold}`);
  const phaseCfg = phaseByName(SCOPE_PHASE);
  if (!phaseCfg || phaseCfg.kind !== 'session') return stop(`hold — config/phases.json has no '${SCOPE_PHASE}' session phase`);
  const commits = await ensureCommits(ctx);
  if (!commits.ok) return stop(commits.did);
  const { m } = commits;
  const off = await switchedOff(ctx);
  if (off) return stop(off);
  const elsewhere = await otherDesk(ctx);
  if (elsewhere) return stop(elsewhere);
  const ticket = await deps.ticket(iid);
  if (!ticket) return stop('hold — cannot read the ticket from GitLab');
  // A feedback round edits the whole previous list, which already covers the
  // ticket's earlier MRs; every other round looks at each of them again.
  const ranges = await rangesToScope(ctx, m);
  const multi = (m.ranges?.length ?? 0) > 1;
  const earlier = request === 'feedback' ? [] : ranges.earlier;

  const erp = erpCheckoutDir(iid);
  j.holding = { erp, since: Date.now() };
  writeLtJournal(j);
  try {
    await deps.erp.add(erp, m.mergeSha);
  } catch (err) {
    await releaseHolding(ctx);
    log.warn(`${tag(iid)} hold — could not check out ${sha7(m.mergeSha)} at ${erp}: ${errText(err).slice(0, 300)}`);
    return stop(`hold — could not check out the merge commit (${errText(err).slice(0, 120)})`);
  }
  const prep = await prepareScopeAt(iid, { base: m.base, head: m.mergeSha }, ltDeps(deps));
  if (!prep.ok) {
    await releaseHolding(ctx);
    const why = `could not prepare the automation worktree — ${cliErrorText(prep.error)}`;
    log.warn(`${tag(iid)} hold — ${why}`);
    await alertOnce(ctx, `prepare:${prep.error.code}`, `Oneshot's local automation tests for #${iid}: ${why}`);
    return stop(`hold — ${why}`);
  }
  j.holding = { erp, wsa: prep.data.wsa, since: j.holding.since };

  // The deterministic analysis of each earlier MR, while the automation
  // worktree is still as the ref left it; its specs join the session's list.
  const extra: Array<{ mrIid: number; spec: ImpactSpec }> = [];
  const scopedEarlier: number[] = [];
  const missed = [...ranges.missed];
  for (const r of earlier) {
    const a = await analyse(ctx, r, prep.data.wsa);
    if (!a.ok) {
      missed.push(r.mrIid);
      log.warn(`${tag(iid)} !${r.mrIid} is not checked — the analysis failed: ${cliErrorText(a.error)}`);
      continue;
    }
    scopedEarlier.push(r.mrIid);
    for (const spec of foundSpecs(a.data)) {
      if (!extra.some((e) => e.spec.file === spec.file)) extra.push({ mrIid: r.mrIid, spec });
    }
  }

  const prev = latestList(j);
  const prevScope = prev ? readList(iid, prev.round) : null;
  const inputs: ScopeInputs = {
    ...prep.data,
    mergeSha: m.mergeSha,
    mrIid: m.mrIid,
    ...(request !== 'first' ? { request } : {}),
    ...(request === 'feedback' && j.request?.feedback ? { feedback: j.request.feedback } : {}),
  };
  // The lap is claimed before the session starts, so a crash mid-session can
  // never make the next one append to this one's transcript.
  const lap = nextLap(iid);
  j.sessions += 1;
  writeLtJournal(j);
  const pctx: PromptCtx = {
    ticket, runId: j.runId, lap, worktree: erp, journal: promptJournal(ctx),
    prior: prevScope ? { [SCOPE_PHASE]: prevScope } : {},
    localTests: inputs,
  };
  log.phase(`${tag(iid)} choosing the tests for !${m.mrIid} (${sha7(m.base)}..${sha7(m.mergeSha)})`
    + `${request === 'first' ? '' : ` — QA asked: ${request}`}`);
  let out: PhaseOutput;
  try {
    out = await deps.session({
      iid, runId: j.runId, lap, cfg: phaseCfg,
      prompt: promptFor(phaseCfg, pctx),
      systemPrompt: systemPromptFor(phaseCfg, pctx),
      worktree: erp,
      // The conductor puts the ticket in the prompt, as the automation mode
      // does, so the session needs no GitLab server — and holds no GitLab
      // write a prompt in the ticket could talk it into.
      gitlabMcp: false,
      signal: ctx.opts.signal,
    });
  } catch (err) {
    out = {
      ok: false, data: null, blocked: null, summary: '', turns: 0, weighted: 0, sessionId: '', rateLimited: false,
      infra: true, error: `the session could not start: ${errText(err)}`,
    };
  }
  // The earlier MRs' specs the session did not list, priced while the worktree is still there.
  const adds = out.ok && out.data ? extra.filter((e) => !specFiles(out.data).includes(e.spec.file)) : [];
  let addMinutes = 0;
  if (adds.length) {
    const priced = await deps.impact(['estimate', '--automation', inputs.wsa, ...adds.map((e) => e.spec.file)]);
    addMinutes = priced.ok ? Number((priced.data.totals as { estimatedMinutes?: unknown } | undefined)?.estimatedMinutes) || 0 : 0;
  }
  // Whatever it concluded: the edits saved and the worktree removed, then the ERP checkout.
  const after = await captureScopeSession(iid, out, inputs, ltDeps(deps));
  await releaseHolding(ctx);
  deps.event('local_tests_session', {
    iid, request, lap, ok: out.ok, turns: out.turns, weighted: out.weighted, blocked: out.blocked, error: out.error ?? null,
  }, j.runId);

  if (!out.ok || !out.data) {
    if (out.blocked) return charge(ctx, `the session reported it was blocked: ${out.blocked}`);
    const c = sessionCharge(out);
    if (c === 'none') return stop(`hold — the session ${out.rateLimited ? 'hit a usage limit' : 'was cancelled'}; nothing charged`);
    if (c === 'account') {
      if (!accountHeld) {
        accountHeld = out.accountAction ?? 'account notice';
        await notify(ctx, accountActionReason(accountHeld, iid));
      }
      return stop('hold — the Claude account needs a one-time action; scope sessions are held for this process');
    }
    if (c === 'free') return freeRetry(ctx, 'the session died before it started');
    return charge(ctx, out.error === NO_STRUCTURED_OUTPUT ? 'the session ended without returning a list'
      : (out.error ?? 'the session failed without saying why').slice(0, 300));
  }
  if (after.refusal) return charge(ctx, after.refusal);
  let scope = after.data ?? out.data;
  const blocked = typeof scope.blocked === 'string' ? scope.blocked.trim() : '';
  if (blocked) return charge(ctx, `the session was blocked: ${blocked}`);
  if (adds.length) {
    const listed = Array.isArray(scope.specs) ? scope.specs as unknown[] : [];
    scope = {
      ...scope,
      applicable: true,
      specs: [...listed, ...adds.map((e) => ({
        file: e.spec.file, module: e.spec.module ?? e.spec.file.split('/')[2] ?? '', cases: e.spec.its ?? 0,
        why: `From !${e.mrIid}: ${e.spec.reasons.find((r) => !r.startsWith('module ')) ?? 'reaches its change'}`,
      }))],
      estimatedMinutes: (Number(scope.estimatedMinutes) || 0) + addMinutes,
    };
  }
  const scopedMrs = !multi ? undefined
    : request === 'feedback' ? prev?.scopedMrs
      : [...(m.ranges ?? []).map((r) => r.mrIid).filter((n) => scopedEarlier.includes(n)), m.mrIid];

  const specs = specFiles(scope);
  const cap = captureOf(scope);
  const tests = (Array.isArray(scope.specs) ? scope.specs as Array<{ cases?: unknown }> : [])
    .reduce((n, s) => n + (Number(s?.cases) || 0), 0);
  const rec = pushList(ctx, {
    source: 'scope',
    kind: specs.length ? 'found' : 'not-found',
    specs,
    notRunnable: notRunnableOf(scope),
    automationSha: cap?.automationSha || inputs.automationSha,
    patchFile: cap?.patchSha ? cap.patchFile : null,
    patchSha: cap?.patchSha ?? null,
    tests,
    estimatedMinutes: Number(scope.estimatedMinutes) || 0,
    ...(scopedMrs ? { scopedMrs } : {}),
  }, scope);
  delete j.request;
  j.attempts = 0;
  j.freeRetries = 0;
  writeLtJournal(j);
  log.ok(`${tag(iid)} round ${rec.round}: ${specs.length ? `${specs.length} test file(s) found` : 'no automation test found'}`
    + `${scopedMrs ? ` across ${mrList(scopedMrs)}` : ''}${missed.length ? ` (not checked: ${mrList(missed)})` : ''}`);
  return go;
}

/**
 * `recheck`: QA says a test for the change is on master now. Deterministic and
 * cheap — no session, nothing earlier repeated: a fresh automation worktree at
 * the automation ref (prepare-scope fetches the clone first), the analysis
 * script — once per merged MR of the ticket's own, their specs together — and
 * the worktree captured away again whatever the script said.
 */
async function stepRecheck(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, deps } = ctx;
  const commits = await ensureCommits(ctx);
  if (!commits.ok) return stop(commits.did);
  const { m } = commits;
  const off = await switchedOff(ctx);
  if (off) return stop(off);
  const { own, earlier, missed } = await rangesToScope(ctx, m);
  const prep = await prepareScope(iid, deps.config(), ltDeps(deps));
  if (!prep.ok) return stop(`hold — could not prepare the automation worktree for the re-check — ${cliErrorText(prep.error)}`);
  j.holding = { wsa: prep.data.wsa, since: Date.now() };
  writeLtJournal(j);
  let analysis: CliResult<Record<string, unknown>> = { ok: true, data: {} };
  let priced: CliResult<Record<string, unknown>> | null = null;
  const found: ImpactSpec[] = [];
  /** A spec only an earlier MR reaches, and which one: its row says so. */
  const fromEarlier = new Map<string, number>();
  try {
    // The tested MR first, then each earlier one: one failure is the re-check's.
    for (const r of [own, ...earlier]) {
      analysis = await analyse(ctx, r, prep.data.wsa);
      if (!analysis.ok) break;
      for (const spec of foundSpecs(analysis.data)) {
        if (found.some((f) => f.file === spec.file)) continue;
        found.push(spec);
        if (r !== own) fromEarlier.set(spec.file, r.mrIid);
      }
    }
    const files = analysis.ok ? found.map((s) => s.file) : [];
    if (files.length) priced = await deps.impact(['estimate', '--automation', prep.data.wsa, ...files]);
  } finally {
    const cap = await captureScope(iid, ltDeps(deps));
    if (!cap.ok) log.warn(`${tag(iid)} the re-check's worktree was not captured — ${cliErrorText(cap.error)}; gc removes it`);
    delete j.holding;
    writeLtJournal(j);
  }
  if (!analysis.ok) {
    const why = `the re-check's analysis failed — ${cliErrorText(analysis.error)}`;
    log.warn(`${tag(iid)} hold — ${why}`);
    await alertOnce(ctx, `recheck:${analysis.error.code}`, `Oneshot's local automation tests for #${iid}: ${why}`);
    return stop(`hold — ${why}`);
  }
  const multi = (m.ranges?.length ?? 0) > 1;
  const scopedMrs = multi ? [...earlier.map((r) => r.mrIid), own.mrIid] : undefined;
  const minutes = priced?.ok ? Number((priced.data.totals as { estimatedMinutes?: unknown } | undefined)?.estimatedMinutes) || 0 : 0;
  const prev = latestList(j);
  const rec: Omit<ListRecord, 'round' | 'noteId' | 'postedAt'> = {
    source: 'recheck',
    kind: found.length ? 'found' : 'recheck-not-found',
    specs: found.map((s) => s.file),
    notRunnable: [],
    automationSha: prep.data.automationSha,
    patchFile: null,
    patchSha: null,
    tests: found.reduce((n, s) => n + (s.its ?? 0), 0),
    ...(minutes ? { estimatedMinutes: minutes } : {}),
    ...(scopedMrs ? { scopedMrs } : {}),
  };
  const scope = listScope({ ...rec, round: 0, noteId: null, postedAt: null }, prev ? readList(iid, prev.round) : null, (file) => {
    const why = found.find((s) => s.file === file)?.reasons.find((r) => !r.startsWith('module ')) ?? 'reaches the change';
    const mr = fromEarlier.get(file);
    return mr ? `From !${mr}: ${why}` : why;
  });
  const saved = pushList(ctx, rec, scope);
  log.ok(`${tag(iid)} round ${saved.round}: re-checked ${sha7(prep.data.automationSha)} — `
    + `${found.length ? `${found.length} test file(s) found` : 'still none'}`
    + `${missed.length ? ` (not checked: ${mrList(missed)})` : ''}`);
  return go;
}

/**
 * `add`: QA added the spec files they name to workstream-automation. Each is
 * looked up on the automation ref after a fetch; the ones there join the list,
 * and the ones not there are named back in the note.
 *
 * The previous list's temporary changes go with them, and so do the specs that
 * depend on them: dropping the patch would leave a spec that needs a patched
 * page object to fail on the intended change, and the MR's author named for it.
 * QA's push moves the ref, so the patch is applied on top of a newer commit
 * than it was cut against; it usually only added files, so the patch still
 * applies, and when it does not, the run says so instead of quietly running
 * without it. The note names the changes that are kept, with the patch.
 */
async function stepAdd(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, deps, cfg } = ctx;
  const ask = j.addFiles;
  if (!ask) {
    j.state = 'awaiting-qa';
    writeLtJournal(j);
    return go;
  }
  const off = await switchedOff(ctx);
  if (off) return stop(off);
  try {
    await deps.git(['fetch', '--quiet', 'origin'], cfg.repo, FETCH_MS);
  } catch (err) {
    log.warn(`${tag(iid)} could not fetch ${cfg.repo}; looking the files up in the refs it has: ${errText(err).slice(0, 200)}`);
  }
  let automationSha: string;
  try {
    automationSha = await deps.git(['rev-parse', '--verify', `${cfg.automationRef}^{commit}`], cfg.repo);
  } catch (err) {
    return stop(`hold — ${cfg.automationRef} does not resolve in ${cfg.repo}: ${errText(err).slice(0, 200)}`);
  }
  const existing: string[] = [];
  const unknown: string[] = [];
  for (const f of ask.files) {
    if (!isSpecPath(f)) { unknown.push(f); continue; }
    try {
      await deps.git(['cat-file', '-e', `${cfg.automationRef}:${f}`], cfg.repo);
      existing.push(f);
    } catch {
      unknown.push(f);
    }
  }
  const prev = latestList(j);
  const prevScope = prev ? readList(iid, prev.round) : null;
  const carry = prev?.kind === 'found' && !!prev.patchSha && !!prev.patchFile ? prev : null;
  if (carry && carry.automationSha !== automationSha) {
    log.info(`${tag(iid)} round ${carry.patchFromRound ?? carry.round}'s temporary changes are kept, on top of `
      + `${sha7(automationSha)} instead of ${sha7(carry.automationSha)}`);
  }
  const kept = prev?.kind === 'found' ? prev.specs : [];
  const specs = [...new Set([...kept, ...existing])];
  const rec: Omit<ListRecord, 'round' | 'noteId' | 'postedAt'> = {
    source: 'added',
    kind: specs.length ? 'found' : 'recheck-not-found',
    specs,
    notRunnable: prev?.kind === 'found' ? prev.notRunnable : [],
    automationSha,
    patchFile: carry ? carry.patchFile : null,
    patchSha: carry ? carry.patchSha : null,
    ...(carry ? { patchFromRound: carry.patchFromRound ?? carry.round } : {}),
    ...(prev?.scopedMrs ? { scopedMrs: prev.scopedMrs } : {}),
    ...(unknown.length ? { unknown } : {}),
  };
  const scope = listScope({ ...rec, round: 0, noteId: null, postedAt: null }, prevScope,
    () => `added to workstream-automation by @${ask.by}`);
  // The earlier specs keep the cases the scope counted; a file QA added has
  // no count yet, so the start note says at least what is known.
  rec.tests = (scope.specs as Array<{ cases?: unknown }>).reduce((n, s) => n + (Number(s?.cases) || 0), 0);
  delete j.addFiles;
  const saved = pushList(ctx, rec, scope);
  log.ok(`${tag(iid)} round ${saved.round}: ${existing.length} added file(s) found on ${cfg.automationRef}`
    + `${unknown.length ? `, not there: ${unknown.join(', ')}` : ''}`);
  return go;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The temporary changes a re-check or an `added` list keeps from an earlier
 * round, with the patch attached: that note has no line of its own for them,
 * and QA approve what runs. Anything capture flagged as weakening a test, or
 * outside localTests.allowedPaths, is named in bold.
 */
function keptChanges(rec: ListRecord, scope: Record<string, unknown> | null): { lines: string[]; attachments: Attachment[] } {
  const cap = captureOf(scope);
  const files = cap?.changedFiles.length ? cap.changedFiles
    : (Array.isArray(scope?.edits) ? scope.edits as Array<{ file?: unknown }> : [])
      .map((e) => (typeof e?.file === 'string' ? e.file : '')).filter(Boolean);
  const cut = cap?.automationSha ?? '';
  const moved = cut && cut !== rec.automationSha
    ? ` — cut against workstream-automation ${codeSpan(sha7(cut))} and applied on top of ${codeSpan(sha7(rec.automationSha))}; `
      + 'if it no longer applies there, the run says so' : '';
  let attachments: Attachment[] = [];
  let attached = 'The patch is attached.';
  const file = rec.patchFile ?? '';
  try {
    if (!file || !existsSync(file)) attached = 'The patch was not found, so it is not attached.';
    else if (statSync(file).size > MAX_UPLOAD_BYTES) attached = 'The patch is over 25 MB, so it is not attached.';
    else attachments = [{ name: basename(file), content: readFileSync(file), mime: mimeFor(file) }];
  } catch {
    attached = 'The patch could not be read, so it is not attached.';
  }
  const lines = [`**Temporary changes kept${rec.patchFromRound ? ` from round ${rec.patchFromRound}` : ''}:** ${files.length
    ? `${plural(files.length, 'file')} (${files.map((f) => codeSpan(f)).join(', ')})` : 'the earlier patch'}, never committed${moved}. ${attached}`];
  const flagged = weakenedFiles(cap);
  if (flagged.length) {
    lines.push('**Temporary changes that weaken a test, reach outside the browser, or touch files outside '
      + `localTests.allowedPaths — read the patch before approving:** ${flagged.map((f) => codeSpan(f)).join(', ')}`);
  }
  return { lines, attachments };
}

/** `lines` as paragraphs after the first paragraph that starts with `before`, or after the headline when there is none. */
function insertParagraphs(body: string, lines: string[], before?: string): string {
  if (!lines.length) return body;
  const at = before ? body.indexOf(`\n\n${before}`) : -1;
  const cut = at >= 0 ? at : body.indexOf('\n\n');
  return cut < 0 ? `${body}\n\n${lines.join('\n\n')}` : `${body.slice(0, cut)}\n\n${lines.join('\n\n')}${body.slice(cut)}`;
}

/**
 * What a list note says besides the list. Under the headline: that it is put
 * to QA again because a reply was ambiguous, and which of the ticket's merged
 * MRs could not be checked. Before the approval ask: the temporary changes a
 * re-check or an `added` list keeps from an earlier round.
 */
function annotate(
  note: LocalTestsNote, rec: ListRecord, scope: Record<string, unknown> | null, m: MergedRef | undefined,
): LocalTestsNote {
  const top: string[] = [];
  const attachments = [...note.attachments];
  if (rec.askedAgain) {
    top.push(`**Asked again:** the reply from ${codeSpan(`@${rec.askedAgain.by}`)} came after another Oneshot request on `
      + 'this ticket, so it may have been meant for that one. Reply under this note to decide these tests.');
  }
  const missed = unscopedMrs(m, rec);
  if (missed.length) {
    top.push(`**Not checked:** ${mrList(missed)}, also merged for this ticket — ${missed.length === 1 ? 'its' : 'their'} `
      + 'change could not be read, so no test was chosen for it. Name any test it needs in your reply.');
  }
  let lower: string[] = [];
  if (rec.source !== 'scope' && rec.patchSha && rec.patchFile) {
    const kept = keptChanges(rec, scope);
    lower = kept.lines;
    attachments.push(...kept.attachments);
  }
  if (!top.length && !lower.length) return note;
  return { body: insertParagraphs(insertParagraphs(note.body, lower, '**Why approval:**'), top), attachments };
}

/** `post`: the list note — found, not found, or what the re-check found — marker-checked. */
async function stepPost(ctx: Ctx, round: number): Promise<StepResult> {
  const j = ctx.j!;
  const { iid } = ctx;
  const rec = j.lists.find((l) => l.round === round);
  if (!rec || !j.merged) return stop(`hold — round ${round} is not in the journal`);
  const off = await switchedOff(ctx);
  if (off) return stop(off);
  // Before this request's first post, one read of the notes serves both the
  // other-desk check and the post's own marker check.
  let current: IssueNote[] | undefined;
  if (!ctx.deps.dryRun && !j.lists.some((l) => l.postedAt !== null)) {
    const r = await ctx.deps.gitlab.notes(iid);
    if (!r.ok || !r.data) return stop(`hold — cannot read the ticket's notes (${r.kind})`);
    current = r.data;
    const elsewhere = await otherDesk(ctx, current);
    if (elsewhere) return stop(elsewhere);
  }
  const scope = readList(iid, round);
  const info = noteInfo(ctx, rec);
  let note: LocalTestsNote;
  if (rec.source === 'scope') {
    note = rec.kind === 'found' ? localTestsFoundNote(scope, info) : localTestsNotFoundNote(scope, info);
  } else {
    const specs = Array.isArray(scope?.specs) ? scope.specs as Array<{ file?: unknown; why?: unknown }> : [];
    note = localTestsRecheckNote({
      found: rec.specs.map((file) => {
        const why = specs.find((s) => s.file === file)?.why;
        return typeof why === 'string' && why ? { file, why } : file;
      }),
      automationSha: rec.automationSha,
      ...(rec.unknown?.length ? { unknown: rec.unknown } : {}),
      ...(rec.estimatedMinutes ? { estimatedMinutes: rec.estimatedMinutes } : {}),
    }, info);
  }
  const post = await postOnce(ctx, `list-r${round}`, annotate(note, rec, scope, j.merged), current);
  if (!post.ok) {
    log.warn(`${tag(iid)} could not post round ${round} (${post.error}) — retrying next tick`);
    return stop(`hold — could not post round ${round}`);
  }
  rec.noteId = post.id;
  rec.postedAt = Date.now();
  if (post.id !== null) j.watermark = Math.max(j.watermark, post.id);
  j.state = 'awaiting-qa';
  writeLtJournal(j);
  ctx.deps.event('local_tests_list_posted', { iid, round, kind: rec.kind, specs: rec.specs.length, adopted: post.adopted }, j.runId);
  log.ok(`${tag(iid)} round ${round} ${post.adopted ? 'was already on the ticket' : 'posted'} — waiting on QA`);
  return go;
}

/**
 * `review`: one read of the newest notes, one decision. DRY_RUN assumes QA's
 * approval (the review gates' precedent) — except right after a setup error,
 * which a dry run never retries by itself.
 *
 * A reply posted after another Oneshot request that itself came after the list
 * (the Ready For Automation mode's cases, say) may answer that request instead:
 * the notes carry no thread to tell. It is not taken as a decision and the
 * watermark stays where it is; the same list is put to QA again, saying why, so
 * the next reply is unambiguously to it.
 */
async function stepReview(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, deps } = ctx;
  const latest = latestList(j);
  if (!latest) return stop('hold — nothing to review');
  if (deps.dryRun) {
    // A setup error is cleared by the next start; still here, it is the one
    // this list was put to QA again for.
    if (j.setupError) return stop('setup error — a dry run does not retry a run that could not happen');
    log.warn(`${tag(iid)} [dry-run] would wait for QA — assuming approval of round ${latest.round}`);
    j.decision = { round: latest.round, by: 'dry-run', noteId: 0, at: new Date().toISOString() };
    j.state = 'approved';
    writeLtJournal(j);
    deps.event('local_tests_approved', { iid, round: latest.round, by: 'dry-run' }, j.runId);
    return go;
  }
  const notes = await deps.gitlab.notes(iid);
  if (!notes.ok || !notes.data) return stop(`hold — cannot read the ticket's notes (${notes.kind})`);
  const since = Math.max(j.watermark, latest.noteId ?? 0);
  const d = qaDecision(notes.data, { since, qa: ctx.qa });
  if (!d) return stop(`round ${latest.round} waiting on QA`);
  const other = foreignRequestBetween(notes.data, latest.noteId ?? since, d.id);
  if (other) {
    log.warn(`${tag(iid)} @${d.by}'s reply (note ${d.id}) came after another Oneshot request (note ${other.id}); `
      + `not read as a decision — round ${latest.round} is put to QA again`);
    deps.event('local_tests_ambiguous_reply', { iid, round: latest.round, by: d.by, note: d.id, other: other.id }, j.runId);
    const { round: _r, noteId: _n, postedAt: _p, askedAgain: _a, ...again } = latest;
    pushList(ctx, { ...again, askedAgain: { by: d.by, noteId: d.id } }, readList(iid, latest.round) ?? {});
    return go;
  }
  j.watermark = Math.max(j.watermark, d.id);
  const said = `@${d.by}`;
  switch (d.reply.kind) {
    case 'approved':
      j.decision = { round: latest.round, by: d.by, noteId: d.id, at: d.at || new Date().toISOString() };
      j.state = 'approved';
      log.ok(`${tag(iid)} round ${latest.round} approved by ${said}`);
      break;
    case 'check-again':
      j.state = 'rechecking';
      log.info(`${tag(iid)} ${said} asked to check workstream-automation again`);
      break;
    case 'added':
      j.addFiles = { files: d.reply.files, noteId: d.id, by: d.by };
      j.state = 'adding';
      log.info(`${tag(iid)} ${said} added ${d.reply.files.join(', ')}`);
      break;
    case 'write-temporary':
      j.request = { kind: 'write-temporary', noteId: d.id, by: d.by };
      j.state = 'scoping';
      j.attempts = 0;
      log.info(`${tag(iid)} ${said} asked for a temporary test`);
      break;
    case 'feedback':
      j.request = { kind: 'feedback', feedback: d.reply.text, noteId: d.id, by: d.by };
      j.state = 'scoping';
      j.attempts = 0;
      log.info(`${tag(iid)} ${said} asked for changes to round ${latest.round}`);
      break;
  }
  writeLtJournal(j);
  deps.event('local_tests_reply', { iid, round: latest.round, by: d.by, kind: d.reply.kind }, j.runId);
  return go;
}

/**
 * One start label edit — the trigger off and `kind`'s label on — recorded as
 * pending BEFORE it is sent. null when it is made; otherwise why not, as the
 * step's stop line.
 *
 * The edit takes the trigger off, so once GitLab applies it the scan cannot
 * find the ticket again: an edit applied whose reply was lost, or a crash right
 * after it, would otherwise leave the ticket on the running label with nothing
 * owed. Pending, it is owed (owesWrites, nextStep), and finished here from the
 * ticket's labels: the target label on and the trigger off is an edit made;
 * the trigger still on is an edit to send (add/remove are idempotent); neither
 * is a request withdrawn before the edit landed.
 */
async function startLabels(
  ctx: Ctx, kind: 'running' | 'done', change: { add: string[]; remove: string[] },
): Promise<string | null> {
  const j = ctx.j!;
  const { iid, deps } = ctx;
  const { trigger } = ctx.cfg.labels;
  const target = ctx.cfg.labels[kind];
  const landed = (labels: string[] | undefined): boolean => (labels ?? []).includes(target) && !(labels ?? []).includes(trigger);
  if (j.pendingLabels === kind && !deps.dryRun) {
    const now = await deps.gitlab.getIssue(iid);
    if (!now.ok || !now.data) return `hold — cannot re-read the labels of #${iid} (${now.kind}) to finish marking it "${target}"`;
    if (landed(now.data.labels)) {
      log.info(`${tag(iid)} the "${target}" label edit had been made — carrying on`);
      delete j.pendingLabels;
      return null;
    }
    if (!(now.data.labels ?? []).includes(trigger) && !ctx.opts.assumeLabel) {
      delete j.pendingLabels;
      writeLtJournal(j);
      return withdrawnStop(ctx);
    }
  }
  j.pendingLabels = kind;
  writeLtJournal(j);
  if (!await editLabels(ctx, change)) {
    // GitLab may have applied it and the answer been lost: the labels say.
    const back = await deps.gitlab.getIssue(iid);
    if (!back.ok || !back.data || !landed(back.data.labels)) return `hold — could not mark #${iid} "${target}"`;
    log.info(`${tag(iid)} GitLab gave no answer to the label edit, but "${target}" is on the ticket — carrying on`);
  }
  delete j.pendingLabels;
  return null;
}

/**
 * `start`: an approval. With tests, the trigger (and a Done label left from an
 * earlier request) comes off and the running label goes on in one edit, and
 * the run follows. With none, the ticket is marked done in one edit and the
 * record says who went on without tests.
 *
 * The approval can be a whole pass old — another ticket's run or session may
 * have held the pass since the scan — so the trigger is read fresh before the
 * first edit, unless an edit of this mode's own is already pending: that
 * edit's own removal of the trigger is not a withdrawal.
 */
async function stepStart(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;
  const d = j.decision;
  const rec = d ? j.lists.find((l) => l.round === d.round) : undefined;
  if (!d || !rec) return stop('hold — approved without an approval record');
  const { trigger, running, done } = cfg.labels;
  if (!j.labelsRunning && !j.labelsDone && !j.pendingLabels) {
    const off = await switchedOff(ctx);
    if (off) return stop(off);
  }
  if (rec.specs.length === 0) {
    if (!j.labelsDone) {
      const held = await startLabels(ctx, 'done', { remove: [trigger], add: [done] });
      if (held) return stop(held);
      j.labelsDone = true;
      writeLtJournal(j);
    }
    const post = await postOnce(ctx, 'approved-without-tests', localTestsApprovedWithoutTestsNote(d.by));
    if (!post.ok) return stop(`hold — the record could not be posted (${post.error})`);
    j.recordPostedAt = Date.now();
    j.state = 'done';
    writeLtJournal(j);
    ctx.deps.event('local_tests_done', { iid, round: d.round, tests: 0, by: d.by }, j.runId);
    log.ok(`${tag(iid)} done — no automation test for this change; approved by @${d.by} without local tests`);
    return stop('done — approved without local tests');
  }
  if (!j.labelsRunning) {
    const held = await startLabels(ctx, 'running', { remove: [trigger, done], add: [running] });
    if (held) return stop(held);
    j.labelsRunning = true;
  }
  delete j.setupError;
  j.state = 'running';
  writeLtJournal(j);
  return go;
}

/** `run`: exactly the approved list, against the merge commit, under the desk's Cypress lease. */
async function stepRun(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, deps } = ctx;
  const d = j.decision;
  const rec = d ? j.lists.find((l) => l.round === d.round) : undefined;
  if (!d || !rec) return stop('hold — running without an approved list');
  // The tick checked before the pass began; a pass can be long.
  if (deps.loopBusy(iid)) return stop('hold — the Loop has a run of this ticket in flight; its run directory is in use');
  const commits = await ensureCommits(ctx);
  if (!commits.ok) return stop(commits.did);
  const { m } = commits;
  // The report reads the scope beside the run: it must be the list that runs.
  const scope = readList(iid, rec.round);
  if (scope) writeArtifact(iid, SCOPE_ARTIFACT, scope);
  const res = await runApprovedTests({
    iid, runId: j.runId, erpRepo: deps.workRepo, ref: m.mergeSha, base: m.base,
    specs: rec.specs, notRunnable: rec.notRunnable, automationSha: rec.automationSha,
    patchFile: rec.patchFile, patchSha: rec.patchSha,
    code: `${m.targetBranch} (merge of !${m.mrIid})`, tests: rec.tests ?? 0, minutes: rec.estimatedMinutes ?? 0,
    dryCypress: deps.dryCypress, signal: ctx.opts.signal,
    onSpawn: (pid) => {
      j.holding = { pids: [pid], since: Date.now() };
      writeLtJournal(j);
    },
  }, {
    ...ltDeps(deps),
    // The start note goes the way every other write here does: refused in DRY_RUN.
    notes: {
      list: async (n) => {
        const r = await deps.gitlab.notes(n);
        return r.ok && r.data ? r.data.map((x) => x.body ?? '') : null;
      },
      add: async (_n, body) => (await postOnce(ctx, `start-${sha12(`${m.mergeSha}|${rec.round}`)}`, { body, attachments: [] })).ok,
    },
  });
  if (j.holding) {
    delete j.holding;
    writeLtJournal(j);
  }
  switch (res.kind) {
    case 'park':
      log.info(`${tag(iid)} parked — ${res.why}`);
      return stop(`parked — ${res.why}`);
    case 'stopped':
      return stop(`stopped — ${res.why}`);
    case 'error':
      saveRunRecord(iid, res.run as unknown as Record<string, unknown>);
      j.setupError = { reason: res.run.reason ?? 'no reason was recorded', at: Date.now(), round: rec.round, labelsRestored: false, postedAt: null, noteId: null };
      j.run = { status: res.run.status, cacheKey: res.run.cacheKey, reason: res.run.reason, at: Date.now() };
      j.state = 'setup-error';
      writeLtJournal(j);
      log.warn(`${tag(iid)} the run could not happen — ${j.setupError.reason}`);
      return go;
    case 'ran':
    default: {
      const run = res.run;
      // Kept beside the journal too: the report still has it if the Loop archives state/runs/<iid> first.
      saveRunRecord(iid, run as unknown as Record<string, unknown>);
      j.run = { status: run.status, cacheKey: run.cacheKey, ...(run.reason ? { reason: run.reason } : {}), at: Date.now() };
      j.state = 'reporting';
      writeLtJournal(j);
      log.ok(`${tag(iid)} ran — ${run.status}${run.status === 'passed' || run.status === 'failed'
        ? ` (${run.totals.passed} passed, ${run.totals.failed} failed)` : run.reason ? `: ${run.reason}` : ''}`);
      return go;
    }
  }
}

/**
 * `report`: the results note, then the done label — passed or failed alike,
 * because the results are what was asked for. Marker-checked, so a crash
 * between the two never posts the results twice.
 */
async function stepReport(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;
  if (ctx.deps.loopBusy(iid)) return stop('hold — the Loop has a run of this ticket in flight; its run directory is in use');
  const mine = (r: LocalTestsRun | null): r is LocalTestsRun => !!r && typeof r.cacheKey === 'string'
    && (!j.run || r.cacheKey === j.run.cacheKey);
  const fromRun = readArtifact<LocalTestsRun>(iid, RUN_ARTIFACT);
  const kept = readRunRecord(iid) as LocalTestsRun | null;
  const run = mine(fromRun) ? fromRun : mine(kept) ? kept : null;
  if (!run) return stop(`hold — state/runs/${iid}/${RUN_ARTIFACT} is missing or is another run's`);
  if (j.resultsPostedAt == null) {
    const note = localTestsResultsNote(run, { iid, runId: j.runId, journal: promptJournal(ctx) },
      j.merged?.author ? { mrAuthor: j.merged.author } : {});
    const post = await postOnce(ctx, `results-${run.cacheKey.slice(0, 12)}`, note);
    if (!post.ok) return stop(`hold — the results could not be posted (${post.error})`);
    j.resultsPostedAt = Date.now();
    j.resultsNoteId = post.id;
    writeLtJournal(j);
  }
  if (!j.labelsDone) {
    if (!await editLabels(ctx, { remove: [cfg.labels.running], add: [cfg.labels.done] })) {
      return stop(`hold — the results are posted, but "${cfg.labels.done}" could not be set`);
    }
    j.labelsDone = true;
  }
  j.state = 'done';
  writeLtJournal(j);
  ctx.deps.event('local_tests_done', {
    iid, status: run.status, passed: run.totals?.passed ?? 0, failed: run.totals?.failed ?? 0,
  }, j.runId);
  log.ok(`${tag(iid)} done — results posted, marked "${cfg.labels.done}"`);
  return stop(`done — ${run.status}, results posted, marked "${cfg.labels.done}"`);
}

/**
 * `restore`: a run that could not happen. The running label comes off and the
 * trigger goes back, the error is posted, and the same list is put to QA again
 * as a new round — approval is still needed before every run, and the next
 * `approved` is the retry. Not marked done.
 */
async function stepRestore(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;
  const se = j.setupError;
  if (!se) {
    j.state = 'awaiting-qa';
    writeLtJournal(j);
    return go;
  }
  if (!se.labelsRestored) {
    if (!await editLabels(ctx, { remove: [cfg.labels.running], add: [cfg.labels.trigger] })) {
      return stop(`hold — could not put "${cfg.labels.trigger}" back`);
    }
    se.labelsRestored = true;
    delete j.labelsRunning;
    writeLtJournal(j);
  }
  if (se.postedAt === null) {
    const post = await postOnce(ctx, `setup-error-${sha12(`${se.at}|${se.round}`)}`, localTestsSetupErrorNote(se.reason));
    if (!post.ok) return stop(`hold — the setup error could not be posted (${post.error})`);
    se.postedAt = Date.now();
    se.noteId = post.id;
    if (post.id !== null) j.watermark = Math.max(j.watermark, post.id);
    writeLtJournal(j);
  }
  const rec = j.lists.find((l) => l.round === se.round);
  delete j.decision;
  if (rec) {
    const { round: _r, noteId: _n, postedAt: _p, askedAgain: _a, ...again } = rec;
    pushList(ctx, again, readList(iid, rec.round) ?? {});
  } else {
    j.state = 'awaiting-qa';
    writeLtJournal(j);
  }
  ctx.deps.event('local_tests_setup_error', { iid, round: se.round, reason: se.reason.slice(0, 300) }, j.runId);
  log.warn(`${tag(iid)} setup error — "${cfg.labels.trigger}" is back and the list is put to QA again`);
  return go;
}

async function maxNoteId(ctx: Ctx): Promise<number | null> {
  const r = await ctx.deps.gitlab.notes(ctx.iid);
  if (!r.ok || !r.data) return null;
  return r.data.reduce((m, n) => Math.max(m, n.id), 0);
}

/**
 * `stuck-poll`: post why the tests could not be chosen until it is on the
 * ticket, learn the ticket's highest note id at that moment, and after that
 * release only on a QA reviewer's comment newer than it.
 */
async function stepStuckPoll(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, deps } = ctx;
  const st = j.stuck;
  if (!st) {
    j.state = 'scoping';
    writeLtJournal(j);
    return go;
  }
  if (st.notePostedAt === null) {
    const off = await switchedOff(ctx);
    if (off) return stop(`stuck — ${off}`);
    const post = await postOnce(ctx, `stuck-${st.fp}`, localTestsStuckNote(st.reason, ctx.qa));
    if (!post.ok) return stop('stuck — note not posted yet');
    st.notePostedAt = Date.now();
    st.sinceNoteId = await maxNoteId(ctx);
    writeLtJournal(j);
    return stop('stuck — waiting for a QA reviewer to comment');
  }
  if (st.sinceNoteId === null) {
    st.sinceNoteId = await maxNoteId(ctx);
    writeLtJournal(j);
    return stop('stuck — waiting for a QA reviewer to comment');
  }
  if (deps.dryRun) return stop('stuck — a dry run never releases itself');
  const notes = await deps.gitlab.notes(iid);
  if (!notes.ok || !notes.data) return stop(`stuck — cannot read the ticket's notes (${notes.kind})`);
  const release = repliesAfter(notes.data, st.sinceNoteId)
    .find((r) => !r.text.startsWith('Oneshot ') && r.user !== null && ctx.qa.includes(r.user));
  if (!release) return stop('stuck — waiting for a QA reviewer to comment');
  delete j.stuck;
  j.state = 'scoping';
  j.attempts = 0;
  j.freeRetries = 0;
  j.watermark = Math.max(j.watermark, release.id);
  writeLtJournal(j);
  log.info(`${tag(iid)} released from stuck by @${release.user} — trying again`);
  return go;
}

function runStep(ctx: Ctx, step: Step): Promise<StepResult> | StepResult {
  switch (step.kind) {
    case 'skip': return stop(step.why);
    case 'hold': return stop(`hold — ${step.why}`);
    case 'check': return stepCheck(ctx, step.reason);
    case 'scope': return stepScope(ctx, step.request);
    case 'recheck': return stepRecheck(ctx);
    case 'add': return stepAdd(ctx);
    case 'post': return stepPost(ctx, step.round);
    case 'review': return stepReview(ctx);
    case 'start': return stepStart(ctx);
    case 'run': return stepRun(ctx);
    case 'report': return stepReport(ctx);
    case 'restore': return stepRestore(ctx);
    case 'stuck-poll': return stepStuckPoll(ctx);
    default: return stop('hold — unknown step');
  }
}

/**
 * Step one ticket until it reaches a waiting point. The caller holds the
 * ticket's lock. Never throws for a GitLab, script or session failure — those
 * are holds — but a programming error does propagate to the tick's catch.
 *
 * A finished journal with the trigger back on the ticket is a new request: a
 * person asked for another run (a follow-up fix merged, say). It is archived
 * and the ticket starts over. Not in DRY_RUN, whose label edits never happen,
 * so the trigger it never took off would restart it on every tick;
 * `--local-tests` archives a finished dry run itself (runLocalTestsOnce).
 */
export async function advanceTicket(issue: Issue, opts: LocalTestsOpts): Promise<LocalTestsOutcome> {
  const iid = issue.iid;
  const deps = withModeDefaults(opts.deps);
  const cfg = deps.config();
  if (!cfg.enabled) return { iid, state: 'skipped', did: `local tests are off on this desk: ${cfg.off}` };
  const project = currentProjectKey();
  const ctx: Ctx = { iid, issue, opts, deps, cfg, qa: deps.qa(), j: readLtJournal(iid) };
  if (ctx.j && ctx.j.project !== project) {
    const to = archiveLtJournal(iid, ctx.j.runId);
    log.warn(`${tag(iid)} its journal was written for ${ctx.j.project ?? 'no project'}, not ${project ?? 'this one'} — `
      + `moved to ${to ?? '(nothing to move)'}; starting fresh`);
    ctx.j = null;
  }
  if (ctx.j?.state === 'done' && !deps.dryRun && (issue.labels ?? []).includes(cfg.labels.trigger)) {
    const to = archiveLtJournal(iid, ctx.j.runId);
    log.info(`${tag(iid)} "${cfg.labels.trigger}" is back on a finished ticket — a new request; the last one is in ${to}`);
    ctx.j = null;
  }

  let did = 'nothing to do';
  for (let n = 0; ; n++) {
    if (opts.signal.aborted) { did = 'stopped for shutdown'; break; }
    if (isPaused(opts)) { did = 'hold — paused (state/PAUSE)'; break; }
    if (n >= MAX_STEPS) {
      did = `stopped after ${MAX_STEPS} steps — continuing next tick`;
      log.warn(`${tag(iid)} ${did}`);
      break;
    }
    const step = nextStep(ctx.j, issue, {
      labels: cfg.labels, project, now: Date.now(), recheckMs: RECHECK_MS, assumeLabel: opts.assumeLabel,
    });
    const res = await runStep(ctx, step);
    if (!res.cont) { did = res.did; break; }
  }
  return { iid, state: ctx.j?.state ?? 'skipped', did };
}

/** One advance under the ticket's lock. A lock someone else holds is a skip, not a failure. */
async function advanceLocked(issue: Issue, opts: LocalTestsOpts): Promise<LocalTestsOutcome> {
  const release = acquireLtLock(issue.iid, opts.conductor);
  if (!release) return { iid: issue.iid, state: 'skipped', did: 'another conductor on this desk is advancing it' };
  try {
    return await advanceTicket(issue, opts);
  } finally {
    release();
  }
}

/**
 * Journals that owe a write the scan can no longer find them for: the trigger
 * is already off — or may be, for a start label edit sent without an answer.
 */
function owesWrites(j: LocalTestsJournal): boolean {
  return j.state === 'running' || j.state === 'reporting' || j.state === 'setup-error'
    || (j.state === 'approved' && (j.labelsDone === true || j.pendingLabels !== undefined));
}

/**
 * One pass over every trigger-labelled ticket, sequentially: one scope session
 * or Cypress run at a time per process. Not awaited by the Loop's tick
 * (index.ts kickLocalTests). Also sweeps the local journals that owe writes —
 * a running list carries the running label, not the trigger — and skips a
 * ticket the Loop has a run in flight for, whose run directory is in use.
 */
export async function localTestsTick(opts: LocalTestsOpts): Promise<void> {
  const deps = withModeDefaults(opts.deps);
  if (!deps.reachable()) return;
  const cfg = deps.config();
  if (!cfg.enabled) return;
  const res = await deps.gitlab.scan(cfg.labels.trigger);
  if (!res.ok || !res.data) {
    log.warn(`local      could not scan for "${cfg.labels.trigger}" tickets`, { kind: res.kind, status: res.status });
    return;
  }
  const candidates: Issue[] = [];
  const seen = new Set<number>();
  for (const i of res.data) {
    if (seen.has(i.iid) || !(i.labels ?? []).includes(cfg.labels.trigger)) continue;
    seen.add(i.iid);
    candidates.push(i);
  }
  for (const j of listLtJournals()) {
    if (seen.has(j.iid) || !owesWrites(j)) continue;
    const got = await deps.gitlab.getIssue(j.iid);
    if (got.ok && got.data) {
      candidates.push(got.data);
      seen.add(j.iid);
    }
  }
  for (const issue of candidates) {
    if (opts.signal.aborted || isPaused(opts)) break;
    if (deps.loopBusy(issue.iid)) {
      log.info(`${tag(issue.iid)} skipped — the Loop has a run of it in flight`);
      continue;
    }
    try {
      const o = await advanceLocked(issue, opts);
      if (o.did.startsWith('another conductor')) log.info(`${tag(issue.iid)} skipped — ${o.did}`);
    } catch (err) {
      log.error(`${tag(issue.iid)} advance threw`, { error: errText(err) });
      deps.event('local_tests_threw', { iid: issue.iid, error: errText(err) });
    }
  }
}

/**
 * `--local-tests <iid>`: the same advance, under the same lock, for one ticket.
 * A ticket without the trigger is left alone like the scan leaves it, unless
 * `--assume-label` (DRY_RUN only) stands in for it or it owes writes. A
 * finished DRY_RUN journal is archived first, so a rehearsal can be run again,
 * and a DRY_RUN list put back after a setup error is retried: the operator
 * asking again is the retry a watch-mode tick never makes by itself.
 */
export async function runLocalTestsOnce(iid: number, opts: LocalTestsOpts): Promise<LocalTestsOutcome> {
  const deps = withModeDefaults(opts.deps);
  const cfg = deps.config();
  if (!cfg.enabled) return { iid, state: 'skipped', did: `local tests are off on this desk: ${cfg.off}` };
  if (opts.assumeLabel && !deps.dryRun) {
    return { iid, state: 'skipped', did: '--assume-label is only allowed with DRY_RUN=1' };
  }
  const res = await deps.gitlab.getIssue(iid);
  if (!res.ok || !res.data) return { iid, state: 'skipped', did: `cannot read #${iid} from GitLab (${res.kind} ${res.status})` };
  let j = readLtJournal(iid);
  if (deps.dryRun && j?.state === 'done') {
    const to = archiveLtJournal(iid, j.runId);
    log.info(`${tag(iid)} [dry-run] the last rehearsal is in ${to} — rehearsing again`);
    j = null;
  }
  if (deps.dryRun && j?.setupError && j.state === 'awaiting-qa') {
    log.info(`${tag(iid)} [dry-run] retrying the run that could not happen: ${j.setupError.reason.slice(0, 200)}`);
    delete j.setupError;
    writeLtJournal(j);
  }
  const labelled = opts.assumeLabel || (res.data.labels ?? []).includes(cfg.labels.trigger);
  if (!labelled && !(j && owesWrites(j))) {
    return {
      iid, state: j?.state ?? 'skipped',
      did: `"${cfg.labels.trigger}" is not on #${iid} — nothing to do${deps.dryRun ? ' (a dry run may pass --assume-label)' : ''}`,
    };
  }
  return advanceLocked(res.data, opts);
}

/**
 * What local-tests runs and scope sessions left on this desk that nothing is
 * holding any more — at boot and on every tick, before the pass. The ERP
 * checkouts are this mode's own (STATE/localtests/<iid>/erp); the automation
 * worktrees, database copies and Cypress processes are scripts/localtests.cjs
 * gc's, told to keep every ticket a live advance holds and every Loop run in
 * flight. Never throws.
 */
export async function localTestsGc(over: Partial<ModeDeps> = {}): Promise<void> {
  const deps = withModeDefaults(over);
  try {
    if (!deps.config().enabled) return;
    const held = new Set(heldLtIids());
    const home = localTestsHome();
    for (const name of existsSync(home) ? readdirSync(home) : []) {
      if (!/^\d+$/.test(name) || held.has(Number(name))) continue;
      const iid = Number(name);
      const dir = erpCheckoutDir(iid);
      if (existsSync(dir)) {
        await deps.erp.remove(dir);
        log.warn(`${tag(iid)} gc removed a scope checkout nothing was holding: ${dir}`);
      }
      const j = readLtJournal(iid);
      if (j?.holding) {
        delete j.holding;
        writeLtJournal(j);
      }
    }
    await gcLocalTests([...held, ...activeRunsFleet().map((r) => r.iid)], ltDeps(deps));
  } catch (err) {
    log.warn(`local      gc failed — ${errText(err)}`);
  }
}

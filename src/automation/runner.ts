/**
 * The Ready For Automation mode: scan, state machine, and the one session.
 *
 * A second, independent mode in the same conductor process. It polls for
 * tickets carrying the Loop's entry label AND the trigger label (any assignee,
 * open or closed, not yet done), proves each one ready with
 * hooks/automation-ready.cjs, has ONE session write the automation test cases,
 * posts them for a QA approver, revises them on request, and on a bare
 * `approved` writes them to the Google Sheet and flips the labels — all in
 * conductor code except the writing itself.
 *
 * The entry label is the master switch for both modes: `Loop` + the trigger is
 * this mode's ticket, `Loop` alone is the Loop pipeline's (which skips the
 * other kind, src/conductor/watcher.ts automationOwns), and no `Loop` is
 * nobody's. The scan, the readiness check (before each session, each version
 * note and the sheet write) and a fresh read before the other writes that
 * follow a session (switchedOff) all require it. The finishing label
 * edit takes `Loop` off with the review label — one label in, one label out —
 * and nothing else here writes the Loop's labels.
 *
 * What it never touches, by construction (R8): the Loop's state/runs, its
 * claim table and `runs` rows, the port pool and the `running` map. Its state
 * is STATE/automation/<iid> (journal.ts), its session gets that directory as
 * `stateDir`, and its only database rows are `events` (kind automation_*, run
 * id `a-…`) and the quota rows runPhase records.
 *
 * The shape of every function here follows from three rules:
 *
 * 1. The journal is the local source of truth, and each tick recomputes the
 *    next step from it and the scanned issue (`nextStep`, pure). There is no
 *    in-memory state beyond the tick's single-flight flag and a few once-per-
 *    process alert switches.
 *
 * 2. Every GitLab write is marker-checked first. A crash between a post and the
 *    journal write adopts the note on the next pass instead of repeating it.
 *    "Posted" means `postedAt` is set, never `noteId`: a DRY_RUN post has no id.
 *
 * 3. `advanceTicket` keeps stepping until it reaches a waiting point — not
 *    ready, in review with nothing new, stuck, done, or a hold — so "approved →
 *    sheet → labels → done" finishes in one tick, and in DRY_RUN the whole
 *    ticket does.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MAX_TURNS, DRY_RUN, PAUSE, ROOT, automationConfig, googleServiceAccountFile, phaseByName,
  projectConfig, reviewersConfig, type AutomationConfig,
} from '../lib/config.js';
import { currentProjectKey } from '../lib/journalproject.js';
import {
  addIssueNote, editIssueLabels, getIssue, issueNotes, issueUrl, issuesWithLabel, readToken, uploadFile,
  type GitlabResult, type Issue, type IssueNote,
} from '../lib/gitlab.js';
import { logEvent } from '../lib/db.js';
import { log } from '../lib/log.js';
import { checkQuota, quotaParked } from '../lib/quota.js';
import { isReachable } from '../lib/reachability.js';
import { alert } from '../lib/slack.js';
import { accountActionReason } from '../lib/accountgate.js';
import { runAutomationReadyGuard } from '../conductor/hooks.js';
import {
  CANCELLED_BY_CONDUCTOR, NO_STRUCTURED_OUTPUT, runPhase, type PhaseOutput,
} from '../conductor/phase.js';
import { isApprovedReply, repliesAfter, type GateReply } from '../conductor/reviewgate.js';
import { schemaFor } from '../conductor/schemas.js';
import {
  casesBody, casesHash, diffCases, doneBody, findMarker, isEmptyDiff, noChangeBody, notReadyBody,
  renderCasesCsv, sanitizeArtifact, sheetFailedBody, stuckBody, validateArtifact, type MarkerKind,
} from './comments.js';
import {
  acquireTicketLock, archiveAutoJournal, automationDir, listAutoJournals, newAutoJournal, readAutoJournal,
  readVersion, saveVersion, writeAutoJournal, type AutomationJournal, type AutomationState, type VersionRecord,
} from './journal.js';
import { fetchAutomationTicket, fetchMergedChanges } from './context.js';
import { automationPrompt, automationSystemPrompt, type AutomationPromptInput } from './prompt.js';
import { AUTOMATION_PHASE, readinessFromHookOutput, withdrawnLabels, type MrRef, type Readiness } from './readiness.js';
import { moduleDisplayName, moduleTabTitle, normaliseModule } from './sheetlayout.js';
import {
  getSpreadsheet, listModuleTabs, loadServiceAccount, writeApprovedCases, type SheetsFail, type SheetsResult,
  type SheetWriteOptions, type SheetWriteResult,
} from './sheets.js';
import type { AutomationArtifact } from './types.js';

export const MAX_AUTHOR_ATTEMPTS = 2;

/** Uncharged failures in a row before one attempt is charged anyway (§1.3). */
const FREE_RETRY_CAP = 3;

/** A sheet failure that clears by waiting (server, network) is reported on the ticket after this long. */
const SHEET_NOTE_AFTER_MS = 60 * 60_000;

/** Sheet failures that do not clear by waiting: reported on the ticket the first time (§5.7). */
const LASTING_SHEET_FAILURES: ReadonlySet<SheetsFail> = new Set<SheetsFail>(
  ['auth', 'permission', 'notfound', 'layout', 'readback', 'client'],
);

/** More steps than any real path takes (DRY_RUN end to end is seven): a bug cannot spin a tick. */
const MAX_STEPS = 16;

/**
 * Tools the automation session must not have, on top of phase.ts's toolPolicy: it only reads.
 *
 * The session is started without the GitLab MCP server at all (`gitlabMcp:
 * false` in stepAuthor): the conductor reads the ticket and the merged diff
 * itself (context.ts) and hands them over in the prompt, so the mode no longer
 * depends on that server starting with its tools. toolPolicy already takes
 * Write/Edit (the phase declares no write scope). This adds:
 * - the shell, the web and subagents, which nothing in this task needs;
 * - every FILE-reading tool, LSP included (it opens any path it is given, and
 *   the rehearsal's first session did point it at the work repo). The session
 *   needs only its prompt, the skill and its structured output. With Read it
 *   could open the Google key (a conventional path, named in the operator's
 *   CLAUDE.md), ~/.claude/settings.json or the per-desk GitLab token —
 *   secret-guard protects only $ONESHOT_HOME/.env — and ticket text is
 *   untrusted while the cases note is posted before a person reads it;
 * - AskUserQuestion: nobody is there to answer it;
 * - the GitLab MCP writes toolPolicy does not list (checked against
 *   @zereight/mcp-gitlab 1.0.77), plus download_attachment, which writes a
 *   file. Inert while the server is not started; they are the floor that holds
 *   if it is ever handed back.
 */
export const AUTOMATION_DENY: readonly string[] = [
  'Bash', 'WebFetch', 'WebSearch', 'Task',
  'Read', 'Grep', 'Glob', 'NotebookRead', 'LSP',
  'AskUserQuestion',
  ...[
    'create_issue_link', 'delete_issue_link', 'create_label', 'update_label', 'delete_label', 'delete_issue',
    'create_wiki_page', 'update_wiki_page', 'delete_wiki_page', 'create_pipeline', 'retry_pipeline',
    'cancel_pipeline', 'fork_repository', 'create_repository', 'create_milestone', 'edit_milestone',
    'delete_milestone', 'promote_milestone', 'delete_draft_note', 'download_attachment',
  ].map((t) => `mcp__gitlab__${t}`),
];

export interface AutomationOpts {
  conductor: string;
  signal: AbortSignal;
  /**
   * Extra env for the readiness script, merged last (runAutomationReadyGuard's
   * `override`). Tests point its ONESHOT_HOME at a scratch home: the script
   * appends its verdict to $ONESHOT_HOME/state/hook-events.jsonl, and the
   * default home is this checkout's live state/.
   */
  guardEnv?: Record<string, string>;
  /**
   * Whether the operator has paused this machine. Default: state/PAUSE exists.
   * A test answers it directly, because touching the real file pauses every
   * phase in flight on the machine.
   */
  paused?: () => boolean;
}

/** state/PAUSE, unless the caller answers it (AutomationOpts.paused). */
function isPaused(opts: AutomationOpts): boolean {
  return opts.paused ? opts.paused() : existsSync(PAUSE);
}
export interface AutomationOutcome { iid: number; state: AutomationState | 'skipped'; did: string }

/**
 * The line `--automation <iid>` ends on. `did` often opens with the state
 * already ("done — sheet written…", "stuck — waiting…", "not ready (…)"), and
 * printing both read "done — done — …", so the state is said once.
 */
export function outcomeLine(o: AutomationOutcome): string {
  const state = o.state.replace(/-/g, ' ');
  const said = new RegExp(`^${state}(?![\\w-])`, 'i').test(o.did);
  return `auto       #${o.iid} ${said ? o.did : `${o.state} — ${o.did}`}`;
}

export type Step =
  | { kind: 'skip'; why: string }
  | { kind: 'check'; reason: 'first' | 'changed' | 'cadence' }
  | { kind: 'author'; mode: 'write' | 'revise' }
  | { kind: 'post'; v: number }                    // cases-v<v>.json saved, postedAt null
  | { kind: 'label-review'; v: number }            // posted, reviewLabelled false: add the review label, then continue
  | { kind: 'review' }
  | { kind: 'sheet' }
  | { kind: 'done-note' }                          // approved && labelsDone && donePostedAt == null — even with Automation Done present
  | { kind: 'stuck-poll' }
  | { kind: 'hold'; why: string };

function tag(iid: number): string {
  return `auto       #${iid}`;
}

function latestVersion(j: AutomationJournal): VersionRecord | undefined {
  return j.versions[j.versions.length - 1];
}

/**
 * Order: done → skip; done-note; Automation Done present → skip; no journal/new → check;
 * not-ready → check when due else hold; stuck → stuck-poll; unposted version → post;
 * unlabelled version → label-review; authoring → author; in-review → review; approved → sheet.
 *
 * A journal stamped for another project is read as no journal: iids are unique
 * only within a project, so it describes some other ticket (advanceTicket moves
 * it aside first). The done-note check comes before the `Automation Done` skip
 * on purpose — a ticket whose labels were flipped but whose last note failed
 * already carries that label, and would otherwise never get the note.
 */
export function nextStep(
  j: AutomationJournal | null,
  issue: Pick<Issue, 'labels' | 'updated_at'>,
  o: { trigger: string; done: string; recheckMs: number; now: number; project: string | null },
): Step {
  const jj = j && j.project === o.project ? j : null;
  const doneLabelled = issue.labels.includes(o.done);
  if (jj?.state === 'done') {
    return {
      kind: 'skip',
      why: doneLabelled
        ? `already ${o.done} — nothing to do`
        : 'finished earlier — archive its state/automation directory and remove its sheet block to redo',
    };
  }
  if (jj && jj.state === 'approved' && jj.labelsDone && jj.donePostedAt == null) return { kind: 'done-note' };
  if (doneLabelled) return { kind: 'skip', why: `already ${o.done} — nothing to do` };
  if (!jj || jj.state === 'new') return { kind: 'check', reason: 'first' };

  if (jj.state === 'not-ready') {
    const r = jj.readiness;
    if (!r) return { kind: 'check', reason: 'first' };
    if (r.issueUpdatedAt !== issue.updated_at) return { kind: 'check', reason: 'changed' };
    if (o.now - r.at >= o.recheckMs) return { kind: 'check', reason: 'cadence' };
    const next = new Date(r.at + o.recheckMs).toISOString().slice(11, 16);
    return { kind: 'hold', why: `not ready (${r.fingerprint ?? 'no fingerprint'}) — next check when the ticket changes, or at ${next} UTC` };
  }
  if (jj.state === 'stuck') return { kind: 'stuck-poll' };

  const latest = latestVersion(jj);
  if (latest && latest.postedAt === null) return { kind: 'post', v: latest.v };
  if (latest && !latest.reviewLabelled) return { kind: 'label-review', v: latest.v };

  if (jj.state === 'authoring') {
    if (jj.pendingFeedback) return { kind: 'author', mode: 'revise' };
    if (!latest) return { kind: 'author', mode: 'write' };
    // A posted version and nothing asked of it: there is nothing to write,
    // only an approver to wait on. Writing a fresh list here would replace
    // the one QA is reading.
    return { kind: 'review' };
  }
  if (jj.state === 'in-review') return { kind: 'review' };
  if (jj.state === 'approved') return { kind: 'sheet' };
  return { kind: 'hold', why: `the journal is in an unknown state '${String(jj.state)}'` };
}

// ------------------------------------------------------------------ the tally

export type ReviewVerdict =
  | { verdict: 'pending'; staleApprovers: string[] }
  | { verdict: 'approved'; by: string; noteId: number; at: string; maxId: number }
  | { verdict: 'revise'; notes: Array<{ id: number; author: string; body: string }>; ignoredApproval: boolean; nearApprovalOnly: boolean; maxId: number };

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * The replies that can move this mode: human, after `since`, from a QA
 * approver, and not one of the Loop's unmarked notes. The desk token belongs
 * to a QA approver, so the Loop's `Oneshot stopped:` / `Oneshot record:` notes
 * — posted without a marker — would otherwise read as that approver asking for
 * changes; they are dropped by the same `Oneshot ` prefix the Loop's own
 * fetchTicket uses.
 */
function approverReplies(notes: IssueNote[], since: number, approvers: string[]): GateReply[] {
  return repliesAfter(notes, since)
    .filter((r) => !r.text.startsWith('Oneshot '))
    .filter((r) => r.user !== null && approvers.includes(r.user));
}

/**
 * Pure. §5.6. Replies = repliesAfter(notes, watermark), minus bodies starting 'Oneshot ' (the Loop's
 * unmarked notes, posted with a token that belongs to a QA approver), approvers only.
 * An `approved` counts only when its id > versionNoteId; an older one approved an earlier version.
 *
 * A change request in the same round outweighs `approved` (and the note says
 * so): R6's word rule is that approval is the single word with nothing else
 * asked, so a round that asks for anything is a round of changes. A
 * near-approval ("Approved.") asks for nothing, so it never outweighs a bare
 * `approved` beside it — otherwise the round would be consumed by a "no change"
 * reply and the real approval lost with it.
 */
export function reviewVerdict(
  notes: IssueNote[], o: { watermark: number; versionNoteId: number; approvers: string[] },
): ReviewVerdict {
  const round = approverReplies(notes, o.watermark, o.approvers);
  const approvals = round.filter((r) => isApprovedReply(r.text));
  const fresh = approvals.filter((r) => r.id > o.versionNoteId);
  const stale = approvals.filter((r) => r.id < o.versionNoteId);
  const feedback = round.filter((r) => !isApprovedReply(r.text) && r.text.trim());
  const asks = feedback.filter((r) => !isNearApproval(r.text));
  if (asks.length || (feedback.length && !fresh.length)) {
    return {
      verdict: 'revise',
      notes: feedback.map((r) => ({ id: r.id, author: r.user ?? '', body: r.text.trim() })),
      ignoredApproval: fresh.length > 0,
      nearApprovalOnly: feedback.every((r) => isNearApproval(r.text)),
      maxId: Math.max(...round.map((r) => r.id)),
    };
  }
  const first = fresh[0];
  if (first) {
    return {
      verdict: 'approved', by: first.user ?? '', noteId: first.id, at: first.at ?? '',
      maxId: Math.max(...round.map((r) => r.id)),
    };
  }
  return { verdict: 'pending', staleApprovers: unique(stale.map((r) => r.user ?? '').filter(Boolean)) };
}

/**
 * "Approved.", "approved ✅", "Approve" — not the bare word. /^\W*approved?\W*$/iu && !isApprovedReply.
 *
 * These say yes, but not in the one form R6 accepts. They get the no-change
 * note explaining the rule instead of a REVISE session, which would at best
 * change nothing and at worst make edits nobody asked for.
 */
export function isNearApproval(text: string): boolean {
  return /^\W*approved?\W*$/iu.test(text) && !isApprovedReply(text);
}

/** The approver note that releases a stuck ticket, or null. Same filters as the tally. */
function stuckReleaseNote(
  notes: IssueNote[], stuck: NonNullable<AutomationJournal['stuck']>, approvers: string[], dryRun: boolean,
): GateReply | null {
  if (dryRun || stuck.sinceNoteId === null) return null;
  return approverReplies(notes, stuck.sinceNoteId, approvers)[0] ?? null;
}

/**
 * Pure. A QA approver's human note (same filters as the tally) with id > stuck.sinceNoteId.
 * false when sinceNoteId is null or dryRun.
 *
 * Only an approver can release it: any developer's unrelated comment would
 * otherwise cost up to two heavy sessions. In DRY_RUN a stuck rehearsal stays
 * stuck rather than paying for sessions every tick.
 */
export function stuckReleased(
  notes: IssueNote[], stuck: NonNullable<AutomationJournal['stuck']>, approvers: string[], dryRun: boolean,
): boolean {
  return stuckReleaseNote(notes, stuck, approvers, dryRun) !== null;
}

// ------------------------------------------------------------------ the scan

/** The Loop's entry label: the master switch this mode requires beside its trigger. */
function loopLabel(): string {
  return projectConfig().labels.entry;
}

/**
 * Tickets to advance: the Loop's entry label and the trigger label present,
 * the done label absent. Assignee and open/closed state are deliberately NOT
 * filtered (R1): QA asks for automation cases on whoever's ticket it is, and
 * often after it closed. Both labels and the done label are filtered
 * server-side too; checking again here costs nothing and keeps a label changed
 * between the two reads from deciding the wrong way.
 */
export function scanFilter(
  issues: Issue[], o: { trigger: string; loop: string; done: string },
): { candidates: Issue[]; skipped: Array<{ iid: number; why: string }> } {
  const candidates: Issue[] = [];
  const skipped: Array<{ iid: number; why: string }> = [];
  const seen = new Set<number>();
  for (const i of issues) {
    if (seen.has(i.iid)) continue;
    seen.add(i.iid);
    const labels = i.labels ?? [];
    if (!labels.includes(o.trigger)) skipped.push({ iid: i.iid, why: `no "${o.trigger}" label` });
    else if (!labels.includes(o.loop)) skipped.push({ iid: i.iid, why: `no "${o.loop}" label` });
    else if (labels.includes(o.done)) skipped.push({ iid: i.iid, why: `already "${o.done}"` });
    else candidates.push(i);
  }
  return { candidates, skipped };
}

/**
 * The scan's one read and its filter. GitLab's `labels=` is an AND, so asking
 * for the trigger and the entry label together returns only the tickets the
 * master switch is on: a `Ready For Automation` ticket nobody put `Loop` on is
 * never read, never checked and never commented on.
 */
export async function automationScan(
  cfg: AutomationConfig, loop: string,
): Promise<GitlabResult<ReturnType<typeof scanFilter>>> {
  const res = await issuesWithLabel([cfg.labels.trigger, loop], { state: 'all', notLabel: cfg.labels.done });
  if (!res.ok || !res.data) return { ...res, data: null };
  return { ...res, data: scanFilter(res.data, { trigger: cfg.labels.trigger, loop, done: cfg.labels.done }) };
}

/**
 * The atomic label edit that finishes a ticket: the review label and the
 * Loop's entry label out, the done label in. `Loop` goes too because it is
 * the master switch — left on, a finished ticket would read as work still
 * asked for — and the done note names exactly this edit.
 */
export function doneLabelEdit(cfg: AutomationConfig, loop: string): { add: string[]; remove: string[] } {
  return { remove: [cfg.labels.review, loop], add: [cfg.labels.done] };
}

// ------------------------------------------------------------------ sessions

/**
 * Pure. §1.3: 'none' (cancelled, rate-limited) | 'account' | 'free' (infra && turns===0) | 'charge'.
 *
 * For a session that did not produce a usable list. The zero-frame rule also
 * requires zero weighted tokens: `turns` comes only from the final result
 * frame, so a session that worked for twenty minutes and then timed out reports
 * turns 0 as well — and that one reached the model and is charged.
 */
export function sessionCharge(out: PhaseOutput): 'none' | 'account' | 'free' | 'charge' {
  if (out.error === CANCELLED_BY_CONDUCTOR) return 'none';
  if (out.rateLimited) return 'none';
  if (out.accountAction) return 'account';
  if (out.infra && out.turns === 0 && out.weighted === 0) return 'free';
  return 'charge';
}

// ------------------------------------------------------------------ process state

/**
 * The only in-memory state. Each is an "alert once per PROCESS" switch (§7),
 * or the hold an account notice puts on every later session: every re-attempt
 * would die at the same CLI gate, so nothing is spent until a person acts and
 * the conductor restarts.
 */
let accountHeld: string | null = null;
let authAlerted = false;
const finishedLogged = new Set<number>();

// ------------------------------------------------------------------ advancing

interface Ctx {
  iid: number;
  issue: Issue;
  opts: AutomationOpts;
  cfg: AutomationConfig;
  /** The Loop's entry label, which this mode requires beside the trigger. */
  loop: string;
  approvers: string[];
  j: AutomationJournal | null;
}

type StepResult = { cont: true } | { cont: false; did: string };
const go: StepResult = { cont: true };
const stop = (did: string): StepResult => ({ cont: false, did });

function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function alertSafe(text: string): Promise<void> {
  try { await alert(text); } catch (err) { log.error(`[alert failed] ${text}`, { error: errText(err) }); }
}

/** alert() once per journal per key, recorded in the journal so a restart does not repeat it. */
async function alertOnce(j: AutomationJournal, key: string, text: string): Promise<void> {
  j.alerted ??= [];
  if (j.alerted.includes(key)) return;
  j.alerted.push(key);
  writeAutoJournal(j);
  await alertSafe(text);
}

function describeMrs(ms: MrRef[]): string {
  return ms.length ? ms.map((m) => `!${m.iid}`).join(', ') : 'no merged MR';
}

/**
 * The readiness script, run by the conductor through runGuard. Anything short
 * of a well-formed verdict for this ticket reads as `unknown`, which every
 * caller holds on.
 */
async function checkReadiness(ctx: Ctx): Promise<Readiness> {
  return readinessFromHookOutput(await runAutomationReadyGuard(ctx.iid, ctx.opts.guardEnv), ctx.iid);
}

/**
 * DRY_RUN only: keep what a write would have carried, in full, under
 * STATE/automation/<iid>/dry-run/ (STATE is the state-dry home in a dry run),
 * numbered in the order the writes would have happened. addIssueNote's own
 * dry-run line gives only a length and batchUpdate's only the first request
 * kinds, and a rehearsal is read for exactly the note QA would see and the rows
 * the sheet would get (§8.3 step 2). Best effort: failing to keep a copy never
 * changes what the rehearsal does.
 */
function keepDry(iid: number, name: string, content: string): string | null {
  if (!DRY_RUN) return null;
  try {
    const dir = join(automationDir(iid), 'dry-run');
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

/** DRY_RUN only: the would-be note, in the log and on disk. */
function keepDryNote(iid: number, label: string, body: string): void {
  if (!DRY_RUN) return;
  const file = keepDry(iid, `note-${label}.md`, body);
  log.info(`${tag(iid)} [dry-run] the ${label} note that would be posted${file ? ` (kept in ${file})` : ''}:\n${body}`);
}

/** DRY_RUN only: the sheet write's options, with a sink that keeps every unsent batch. */
function sheetOptions(iid: number): SheetWriteOptions {
  if (!DRY_RUN) return { dryRun: false };
  return {
    dryRun: true,
    dryRunSink: (tab, requests) => {
      const file = keepDry(iid, `sheet-${tab}.json`, `${JSON.stringify(requests, null, 2)}\n`);
      if (file) log.info(`${tag(iid)} [dry-run] ${requests.length} requests for '${tab}' kept in ${file}`);
    },
  };
}

/**
 * Post a note unless one carrying the same marker is already among the newest
 * notes (a crash between an earlier post and its journal write). `notes` may
 * be passed when the caller has just read them.
 */
async function postOnce(
  iid: number, kind: MarkerKind, detail: string | undefined, body: string, notes?: IssueNote[],
): Promise<{ ok: boolean; id: number | null; adopted: boolean; error?: string }> {
  let list = notes;
  if (!list) {
    const r = await issueNotes(iid);
    if (!r.ok || !r.data) return { ok: false, id: null, adopted: false, error: `cannot read the ticket's notes (${r.kind})` };
    list = r.data;
  }
  const hit = findMarker(list, kind, detail);
  if (hit) return { ok: true, id: hit.id, adopted: true };
  keepDryNote(iid, detail ? `${kind}-${detail}` : kind, body);
  const posted = await addIssueNote(iid, body);
  if (!posted.ok) return { ok: false, id: null, adopted: false, error: `the post failed (${posted.kind} ${posted.status})` };
  return { ok: true, id: posted.data?.id ?? null, adopted: false };
}

/**
 * The not-ready path: record the verdict, and post its note once per
 * fingerprint (skip when recorded, adopt when the marker is on the ticket,
 * post otherwise). Everything earlier — versions, watermark, pending feedback,
 * an approval — is kept, so a ticket that becomes ready again resumes where it
 * was instead of being rewritten.
 */
async function enterNotReady(ctx: Ctx, j: AutomationJournal, r: Readiness): Promise<string> {
  const { iid, cfg } = ctx;
  j.readiness = {
    verdict: 'not-ready', at: Date.now(), issueUpdatedAt: r.issueUpdatedAt ?? ctx.issue.updated_at,
    fingerprint: r.fingerprint, merged: r.merged, open: r.open,
  };
  j.state = 'not-ready';
  writeAutoJournal(j);
  const fp = r.fingerprint ?? 'none';
  const codes = r.reasons.map((x) => x.code).join(', ');
  if (j.notReadyPosted.includes(fp)) return `not ready (${fp}: ${codes}) — already commented`;
  const post = await postOnce(iid, 'not-ready', r.fingerprint ?? undefined, notReadyBody(r, {
    recheckMinutes: cfg.recheckMinutes, trigger: cfg.labels.trigger, deployed: cfg.labels.deployed,
  }));
  if (!post.ok) {
    log.warn(`${tag(iid)} not ready (${fp}) — the comment could not be posted: ${post.error}; it is tried again at the next check`);
    return `not ready (${fp}: ${codes}) — comment not posted yet`;
  }
  j.notReadyPosted.push(fp);
  writeAutoJournal(j);
  log.info(`${tag(iid)} not ready (${fp}: ${codes}) — ${post.adopted ? 'already commented' : 'commented'}`);
  return `not ready (${fp}: ${codes}) — ${post.adopted ? 'already commented' : 'commented'}`;
}

/** The silent stop for a withdrawn switch label: a log line and the outcome, nothing on the ticket. */
function withdrawnStop(iid: number, missing: string[]): string {
  const names = missing.map((l) => `"${l}"`).join(' and ');
  const verb = missing.length > 1 ? 'are' : 'is';
  log.info(`${tag(iid)} ${names} ${verb} not on the ticket — stopping, journal kept`);
  return `${names} ${verb} not on the ticket — stopped`;
}

/**
 * Both switch labels, read fresh, just before a write that can come long after
 * the scan read them: an authoring session runs for up to half an hour, and
 * the review label, the no-change note and the stuck note follow it in the
 * same pass, on the scan's copy of the labels (the version note goes through
 * the whole readiness check instead, in stepPost). A `Loop` or
 * trigger a person took off meanwhile stops them the way the readiness gate
 * stops everything else — silently, journal kept, so the write happens when
 * the label is back. null when both are on; otherwise what the step says. A
 * failed read is a hold: nothing is written without seeing the switch on.
 * Never asked before the done note, whose ticket the finishing edit has
 * already taken `Loop` off.
 */
async function switchedOff(ctx: Ctx): Promise<string | null> {
  const res = await getIssue(ctx.iid);
  if (!res.ok || !res.data) return `hold — cannot re-read the ticket's labels (${res.kind})`;
  const labels = res.data.labels ?? [];
  const missing = [ctx.loop, ctx.cfg.labels.trigger].filter((l) => !labels.includes(l));
  return missing.length ? withdrawnStop(ctx.iid, missing) : null;
}

/**
 * Act on a readiness verdict. `ready` records it and lets the caller carry on;
 * anything else has already been handled here (the not-ready note, a log line
 * for a hold, a silent stop for a withdrawn `Loop` or trigger) and the caller
 * stops.
 */
async function gateOnReadiness(
  ctx: Ctx, j: AutomationJournal, r: Readiness, where: string,
): Promise<{ ready: true } | { ready: false; did: string }> {
  const { iid, cfg } = ctx;
  logEvent('automation_readiness', {
    iid, where, verdict: r.verdict, fingerprint: r.fingerprint, reasons: r.reasons.map((x) => x.code),
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
  }, { runId: j.runId, phase: AUTOMATION_PHASE });

  if (r.verdict === 'unknown') {
    const why = `readiness could not be checked (${r.errorKind ?? 'other'}): ${r.error ?? 'no reason given'}`;
    log.warn(`${tag(iid)} hold — ${why}`);
    logEvent('automation_hold', { iid, where, why }, { runId: j.runId, phase: AUTOMATION_PHASE });
    if (r.errorKind === 'auth' && !authAlerted) {
      authAlerted = true;
      await alertSafe(`Oneshot's Ready For Automation mode cannot read GitLab: the token was refused (${r.error ?? '401/403'}). `
        + 'A bad token never heals by waiting — fix GITLAB_READ_TOKEN or this desk\'s token.');
    }
    return { ready: false, did: `hold — ${why}` };
  }
  const withdrawn = withdrawnLabels(r, { loop: ctx.loop, trigger: cfg.labels.trigger });
  if (withdrawn.length) {
    // A missing switch label (Loop or the trigger) withdraws the request; it is
    // not something to "fix", so nothing is posted and the journal stays as it
    // is for when the label returns.
    return { ready: false, did: withdrawnStop(iid, withdrawn) };
  }
  if (r.verdict === 'not-ready') return { ready: false, did: await enterNotReady(ctx, j, r) };

  j.readiness = {
    verdict: 'ready', at: Date.now(), issueUpdatedAt: r.issueUpdatedAt ?? ctx.issue.updated_at,
    fingerprint: null, merged: r.merged, open: r.open,
  };
  writeAutoJournal(j);
  return { ready: true };
}

/** `check`: first sight, or a due re-check of a not-ready ticket. */
async function stepCheck(ctx: Ctx, reason: 'first' | 'changed' | 'cadence'): Promise<StepResult> {
  if (!ctx.j) {
    ctx.j = newAutoJournal(ctx.iid, ctx.issue.title);
    writeAutoJournal(ctx.j);
  }
  const j = ctx.j;
  const r = await checkReadiness(ctx);
  const g = await gateOnReadiness(ctx, j, r, `check:${reason}`);
  if (!g.ready) return stop(g.did);
  // Leaving not-ready keeps everything earlier (§1.4).
  j.state = j.approval ? 'approved' : j.pendingFeedback ? 'authoring' : j.versions.length ? 'in-review' : 'authoring';
  writeAutoJournal(j);
  log.info(`${tag(ctx.iid)} ready — ${describeMrs(r.merged)} merged${r.warnings.length ? ` (${r.warnings.join('; ')})` : ''}`);
  return go;
}

/**
 * A charged authoring failure. The second one in a row makes the ticket
 * `stuck`: the stuck-poll step posts its note, and only a QA approver's
 * comment releases it. Any session that reached the model resets freeRetries.
 *
 * The stuck fingerprint hashes the reason AND the moment it got stuck, so the
 * marker check only ever adopts this episode's note: a second episode failing
 * the same way still gets its own note.
 */
async function charge(ctx: Ctx, reason: string): Promise<StepResult> {
  const j = ctx.j!;
  j.attempts += 1;
  j.freeRetries = 0;
  const short = reason.slice(0, 500);
  log.warn(`${tag(ctx.iid)} authoring attempt ${j.attempts} of ${MAX_AUTHOR_ATTEMPTS} failed: ${short}`);
  logEvent('automation_hold', { iid: ctx.iid, why: 'authoring failed', attempts: j.attempts, reason: short },
    { runId: j.runId, phase: AUTOMATION_PHASE });
  if (j.attempts < MAX_AUTHOR_ATTEMPTS) {
    writeAutoJournal(j);
    return stop(`authoring attempt ${j.attempts} of ${MAX_AUTHOR_ATTEMPTS} failed — retrying next tick: ${short}`);
  }
  const at = Date.now();
  j.state = 'stuck';
  j.stuck = { at, reason: short, fp: sha12(`${short}|${at}`), notePostedAt: null, sinceNoteId: null };
  writeAutoJournal(j);
  await alertOnce(j, 'stuck',
    `Oneshot could not write the automation test cases for #${ctx.iid} after ${MAX_AUTHOR_ATTEMPTS} attempts: ${short}`);
  return go;
}

/** An uncharged failure. Three in a row charge one attempt and alert once. */
async function freeRetry(ctx: Ctx, why: string): Promise<StepResult> {
  const j = ctx.j!;
  j.freeRetries += 1;
  if (j.freeRetries >= FREE_RETRY_CAP) {
    const reason = `${FREE_RETRY_CAP} sessions in a row ended before reaching the model (${why})`;
    await alertOnce(j, 'free-retries', `Oneshot's automation session for #${ctx.iid}: ${reason}. One attempt is being `
      + 'charged so this cannot loop; a change in the CLI or the hook is the likely cause.');
    return charge(ctx, reason);
  }
  writeAutoJournal(j);
  log.warn(`${tag(ctx.iid)} hold — ${why}; nothing charged (${j.freeRetries} of ${FREE_RETRY_CAP} in a row)`);
  return stop(`hold — ${why}; nothing charged`);
}

/** The ids earlier versions used that the latest one no longer carries, with their scenarios. */
function removedIds(iid: number, j: AutomationJournal): Map<string, string> | undefined {
  const latest = latestVersion(j);
  if (!latest) return undefined;
  const current = new Set((readVersion(iid, latest.v)?.cases ?? []).map((c) => c.id));
  const removed = new Map<string, string>();
  for (const rec of j.versions) {
    for (const c of readVersion(iid, rec.v)?.cases ?? []) if (!current.has(c.id)) removed.set(c.id, c.scenario);
  }
  return removed.size ? removed : undefined;
}

/** The next unused case id across every saved version: 'TC-01' for a fresh list. */
function nextCaseId(iid: number, j: AutomationJournal): string {
  let max = 0;
  for (const rec of j.versions) {
    for (const c of readVersion(iid, rec.v)?.cases ?? []) {
      const m = /^TC-(\d+)$/.exec(c.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `TC-${String(max + 1).padStart(2, '0')}`;
}

/**
 * The highest version already posted on the ticket, from the cases markers
 * (the format comments.ts `marker('cases', 'v<N>:<hash>')` writes). Non-zero
 * only when the journal was lost while GitLab kept the notes: the fresh list is
 * then numbered after them rather than posted as a second "v1".
 */
function highestPostedVersion(notes: IssueNote[]): number {
  let max = 0;
  for (const n of notes) {
    if (n.system) continue;
    for (const m of (n.body ?? '').matchAll(/^[ \t]*<!--\s*oneshot:automation:cases:v(\d+):/gm)) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

/** The sheet tab a module's cases will go to, from the module list the session was shown. */
function tabFor(module: string, modules: Array<{ tab: string; module: string }>, prefix: string): { tab: string; isNew: boolean } {
  const key = normaliseModule(module);
  const hit = key ? modules.find((m) => normaliseModule(m.module) === key) : undefined;
  if (hit) return { tab: hit.tab, isNew: false };
  try {
    return { tab: moduleTabTitle(prefix, module), isNew: true };
  } catch {
    return { tab: module, isNew: true };
  }
}

function failureReason(out: PhaseOutput): string {
  if (out.error === NO_STRUCTURED_OUTPUT) return 'the session ended without returning a list';
  return (out.error ?? 'the session failed without saying why').slice(0, 300);
}

/**
 * A REVISE whose output changes no case: say so on the ticket, and go back to
 * waiting on the same version. The round was consumed when it was read, so
 * the watermark is already past it. Best effort: a failed post is logged, not
 * retried, because retrying would mean paying for the session again.
 */
async function noChange(ctx: Ctx, latest: VersionRecord, sessionNotes: string[]): Promise<StepResult> {
  const j = ctx.j!;
  const pf = j.pendingFeedback;
  const authors = unique((pf?.notes ?? []).map((n) => n.author).filter(Boolean));
  const maxId = Math.max(0, ...(pf?.notes ?? []).map((n) => n.id));
  // Best effort, like a failed post: with the switch off the note is dropped,
  // not owed, and the round is consumed all the same.
  const off = await switchedOff(ctx);
  if (off) {
    log.warn(`${tag(ctx.iid)} the no-change note was not posted: ${off}`);
  } else {
    const post = await postOnce(ctx.iid, 'nochange', String(maxId), noChangeBody({
      v: latest.v, authors, notes: sessionNotes, nearApproval: false, maxNoteId: maxId,
    }));
    if (!post.ok) log.warn(`${tag(ctx.iid)} the no-change note could not be posted: ${post.error}`);
  }
  delete j.pendingFeedback;
  j.state = 'in-review';
  j.attempts = 0;
  j.freeRetries = 0;
  // The watermark stays at the consumed round, NOT this note: a comment an
  // approver posted while the session ran sits between the two and must still
  // be read. This note is a machine note, so the tally never counts it anyway.
  writeAutoJournal(j);
  logEvent('automation_feedback', { iid: ctx.iid, v: latest.v, outcome: 'no-change', authors },
    { runId: j.runId, phase: AUTOMATION_PHASE });
  if (off) return stop(`no change to v${latest.v} — ${off}`);
  log.info(`${tag(ctx.iid)} revision of v${latest.v} changed nothing — said so, still waiting on QA`);
  return stop(`no change to v${latest.v} — said so on the ticket`);
}

/** `author`: the readiness check, then ONE session, then validation and saving the version. */
async function stepAuthor(ctx: Ctx, mode: 'write' | 'revise'): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;

  // Holds that cost nothing, before anything that costs a GET or a session.
  // (state/PAUSE is checked before every step, in advanceTicket.)
  if (quotaParked()) return stop('hold — parked after a subscription usage limit');
  const quota = checkQuota(j.runId, AUTOMATION_PHASE, j.sessions);
  if (!quota.allowed) return stop(`hold — ${quota.reason ?? 'over budget'}`);
  if (accountHeld) return stop('hold — the Claude account needs a one-time action (see the alert); restart once it is done');
  const phaseCfg = phaseByName(AUTOMATION_PHASE);
  if (!phaseCfg || phaseCfg.kind !== 'session') return stop(`hold — config/phases.json has no '${AUTOMATION_PHASE}' session phase`);

  // The module list is a required prompt input: a session that has to guess
  // the module is a session paid for a list the sheet may file wrongly.
  const modules = await listModuleTabs(cfg.sheet, googleServiceAccountFile());
  if (!modules.ok) {
    log.warn(`${tag(iid)} hold — cannot list the sheet's module tabs (${modules.kind}): ${modules.error}`);
    return stop(`hold — cannot list the sheet's module tabs (${modules.kind})`);
  }

  const latest = latestVersion(j);
  let previous: AutomationPromptInput['previous'];
  if (mode === 'revise') {
    const prev = latest ? readVersion(iid, latest.v) : null;
    if (!latest || !prev) return charge(ctx, `the saved v${latest?.v ?? '?'} list is missing, so there is nothing to revise`);
    previous = { version: latest.v, module: prev.module, cases: prev.cases };
  }

  // The gate. Only `ready` spends a session.
  const g = await gateOnReadiness(ctx, j, await checkReadiness(ctx), `pre-${mode}`);
  if (!g.ready) return stop(g.did);

  let base = latest?.v ?? 0;
  let lostHistory = false;
  if (mode === 'write' && !latest) {
    const notes = await issueNotes(iid);
    if (!notes.ok || !notes.data) return stop(`hold — cannot read the ticket's notes (${notes.kind})`);
    base = highestPostedVersion(notes.data);
    lostHistory = base > 0;
  }

  const ticket = await fetchAutomationTicket(iid);
  if (!ticket) return stop('hold — cannot read the ticket from GitLab');
  // The merged fix MRs readiness named — never the open ones, never a
  // promotion — read in full before anything is paid for. A change the
  // session saw only part of would give a list that looks whole and is not.
  const merged = j.readiness?.merged ?? [];
  const changes = await fetchMergedChanges(merged);
  if (!changes.ok) {
    log.warn(`${tag(iid)} hold — ${changes.error}; nothing charged, tried again next tick`);
    return stop(`hold — ${changes.error}`);
  }

  const project = projectConfig().gitlab.project;
  const pf = j.pendingFeedback;
  const input: AutomationPromptInput = {
    mode,
    ticket,
    changes: changes.changes,
    open: j.readiness?.open ?? [],
    modules: modules.data,
    ...(previous ? { previous } : {}),
    ...(mode === 'revise' && pf ? {
      feedback: pf.notes.map((n) => ({ author: n.author, body: n.body })),
      ignoredApproval: pf.ignoredApproval,
    } : {}),
    nextId: nextCaseId(iid, j),
    maxTurns: phaseCfg.maxTurns ?? DEFAULT_MAX_TURNS,
  };

  // The lap is claimed before the session starts, so a crash mid-session can
  // never make the next one append to this one's transcript.
  const lap = j.sessions;
  j.sessions += 1;
  writeAutoJournal(j);
  log.phase(mode === 'write'
    ? `${tag(iid)} ready — writing v${base + 1} from ${describeMrs(changes.changes.map((c) => c.mr))}`
    : `${tag(iid)} revising v${latest?.v} for ${unique((pf?.notes ?? []).map((n) => `@${n.author}`)).join(', ')}`);

  const out = await runPhase({
    iid, runId: j.runId, lap, cfg: phaseCfg,
    prompt: automationPrompt(input),
    systemPrompt: automationSystemPrompt(phaseCfg, iid, project),
    stateDir: automationDir(iid),
    gitlabMcp: false,
    disallowTools: [...AUTOMATION_DENY],
    signal: ctx.opts.signal,
  });
  logEvent('automation_session', {
    iid, mode, lap, ok: out.ok, turns: out.turns, weighted: out.weighted,
    blocked: out.blocked, error: out.error, infra: out.infra ?? false,
  }, { runId: j.runId, phase: AUTOMATION_PHASE });

  if (!out.ok || !out.data) {
    if (out.blocked) return charge(ctx, `the session reported it was blocked: ${out.blocked}`);
    const c = sessionCharge(out);
    if (c === 'none') {
      return stop(`hold — the session ${out.rateLimited ? 'hit a usage limit' : 'was cancelled'}; nothing charged`);
    }
    if (c === 'account') {
      if (!accountHeld) {
        accountHeld = out.accountAction ?? 'account notice';
        await alertSafe(accountActionReason(accountHeld, iid));
      }
      return stop('hold — the Claude account needs a one-time action; automation sessions are held for this process');
    }
    if (c === 'free') return freeRetry(ctx, 'the session died before it started');
    return charge(ctx, failureReason(out));
  }

  // The session reached the model and returned a list.
  j.freeRetries = 0;
  const clean = sanitizeArtifact(out.data as unknown as AutomationArtifact);
  if ('refused' in clean) return charge(ctx, clean.refused);
  const artifact = clean.artifact;
  // Read the module the way a tab title is read, so `TestCases_Profile`
  // becomes `Profile`: the sheet matches tabs on that form, and the prefixed
  // spelling would otherwise create `TestCases_TestCases_Profile`.
  const shown = moduleDisplayName(typeof artifact.module === 'string' ? artifact.module : '');
  if (shown) artifact.module = shown;
  const invalid = validateArtifact(artifact, removedIds(iid, j));
  if (invalid) return charge(ctx, `the list was not usable: ${invalid}`);

  if (mode === 'revise' && previous && latest) {
    const diff = diffCases(previous.cases, artifact.cases);
    if (isEmptyDiff(diff)) return noChange(ctx, latest, artifact.changes ?? []);
  }

  const v = base + 1;
  saveVersion(iid, v, artifact);
  const tab = tabFor(artifact.module, modules.data, cfg.sheet.moduleTabPrefix);
  const rec: VersionRecord = {
    v, module: artifact.module, count: artifact.cases.length, hash: casesHash(artifact.cases),
    noteId: null, postedAt: null, reviewLabelled: false, changes: artifact.changes ?? [],
    moduleTab: tab.tab, moduleTabIsNew: tab.isNew,
    ...(mode === 'revise' && pf ? {
      feedbackAuthors: unique(pf.notes.map((n) => n.author).filter(Boolean)), ignoredApproval: pf.ignoredApproval,
    } : {}),
    ...(lostHistory ? { lostHistory: true } : {}),
  };
  j.versions.push(rec);
  delete j.pendingFeedback;
  j.state = 'in-review';
  j.attempts = 0;
  j.freeRetries = 0;
  writeAutoJournal(j);
  log.ok(`${tag(iid)} v${v} written (${rec.count} cases, module ${rec.module})`);
  return go;
}

/**
 * Approver replies that arrived while a revision was being written: newer than
 * the consumed watermark, older than the note about to be posted. Their change
 * requests become the NEXT version (the tally reads them next), and an
 * `approved` among them approved the previous version, so the note says both.
 */
function during(notes: IssueNote[], watermark: number, approvers: string[]): { changeAuthors: string[]; staleApprovers: string[] } | undefined {
  const round = approverReplies(notes, watermark, approvers);
  const changeAuthors = unique(round.filter((r) => !isApprovedReply(r.text) && r.text.trim()).map((r) => r.user ?? '').filter(Boolean));
  const staleApprovers = unique(round.filter((r) => isApprovedReply(r.text)).map((r) => r.user ?? '').filter(Boolean));
  return changeAuthors.length || staleApprovers.length ? { changeAuthors, staleApprovers } : undefined;
}

/** `post`: the cases note, marker-checked, with the CSV attached. */
async function stepPost(ctx: Ctx, v: number): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;
  const idx = j.versions.findIndex((x) => x.v === v);
  const rec = j.versions[idx];
  const art = readVersion(iid, v);
  if (!rec || !art) {
    log.error(`${tag(iid)} cases-v${v}.json is missing — archive state/automation/${iid} to start this ticket over`);
    return stop(`hold — the saved v${v} list is missing`);
  }
  // The full readiness check, not only the labels: the list was written up to
  // half an hour after the last check, and a ticket that was ready only
  // because it was closed may have been reopened meanwhile. A list for a change
  // that no longer reads as shipped must not reach QA. A withdrawn `Loop` or
  // trigger stops silently here too, as switchedOff would.
  const g = await gateOnReadiness(ctx, j, await checkReadiness(ctx), `pre-post:v${v}`);
  if (!g.ready) return stop(g.did);
  const notes = await issueNotes(iid);
  if (!notes.ok || !notes.data) return stop(`hold — cannot read the ticket's notes (${notes.kind})`);

  const first = idx === 0;
  const existing = findMarker(notes.data, 'cases', `v${v}:`);
  let noteId: number | null;
  if (existing) {
    noteId = existing.id;
    log.info(`${tag(iid)} v${v} was already on the ticket — adopted note ${existing.id}`);
  } else {
    const prevRec = idx > 0 ? j.versions[idx - 1] : undefined;
    const prevArt = prevRec ? readVersion(iid, prevRec.v) : null;
    const csv = renderCasesCsv(art.cases);
    keepDry(iid, `automation-testcases-${iid}-v${v}.csv`, csv);
    const up = await uploadFile(`automation-testcases-${iid}-v${v}.csv`, csv, 'text/csv');
    if (!up.ok) log.warn(`${tag(iid)} the v${v} CSV could not be attached (${up.kind}) — the note says so`);
    let moduleTab = rec.moduleTab;
    if (!moduleTab) {
      try { moduleTab = moduleTabTitle(cfg.sheet.moduleTabPrefix, art.module); } catch { moduleTab = art.module; }
    }
    const view = {
      iid, v, module: art.module, moduleTab, moduleTabIsNew: rec.moduleTabIsNew ?? false,
      cases: art.cases, merged: j.readiness?.merged ?? [], open: j.readiness?.open ?? [],
      approvers: ctx.approvers, csvMarkdown: up.ok && up.data ? up.data.markdown : null,
      hash: rec.hash, doneLabel: cfg.labels.done,
      ...(prevArt ? { diff: diffCases(prevArt.cases, art.cases) } : {}),
      ...(!first ? { notes: art.changes ?? [] } : {}),
      ...(rec.feedbackAuthors ? { feedbackAuthors: rec.feedbackAuthors } : {}),
      ...(rec.ignoredApproval ? { ignoredApproval: true } : {}),
      ...(rec.lostHistory ? { lostHistory: true } : {}),
    };
    const dur = first ? undefined : during(notes.data, j.watermark, ctx.approvers);
    const body = casesBody(dur ? { ...view, during: dur } : view);
    keepDryNote(iid, `cases-v${v}`, body);
    const posted = await addIssueNote(iid, body);
    if (!posted.ok) {
      log.warn(`${tag(iid)} could not post v${v} (${posted.kind} ${posted.status}) — retrying next tick`);
      return stop(`hold — could not post v${v}`);
    }
    noteId = posted.data?.id ?? null;
  }
  rec.noteId = noteId;
  rec.postedAt = Date.now();
  // The first version's note is the line older comments cannot count behind.
  // Later versions do NOT move it: a change request posted while a REVISE ran
  // sits between the consumed round and the new note, and must still be read.
  if (first && noteId !== null) j.watermark = Math.max(j.watermark, noteId);
  writeAutoJournal(j);
  logEvent('automation_version_posted', { iid, v, count: rec.count, noteId, adopted: Boolean(existing) },
    { runId: j.runId, phase: AUTOMATION_PHASE });
  log.ok(`${tag(iid)} v${v} posted (${rec.count} cases) — waiting on QA`);
  return go;
}

/** `label-review`: the board marker, added atomically. On failure it is the next step again, before any tally. */
async function stepLabelReview(ctx: Ctx, v: number): Promise<StepResult> {
  const j = ctx.j!;
  const rec = j.versions.find((x) => x.v === v);
  if (!rec) return stop(`hold — v${v} is not in the journal`);
  const off = await switchedOff(ctx);
  if (off) return stop(off);
  const res = await editIssueLabels(ctx.iid, { add: [ctx.cfg.labels.review] });
  if (!res.ok) {
    log.warn(`${tag(ctx.iid)} could not add "${ctx.cfg.labels.review}" (${res.kind}) — retrying next tick`);
    return stop(`hold — could not add "${ctx.cfg.labels.review}"`);
  }
  rec.reviewLabelled = true;
  writeAutoJournal(j);
  return go;
}

/** `review`: one read of the newest notes, one verdict. DRY_RUN auto-approves (the checkApprovalGate precedent). */
async function stepReview(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid } = ctx;
  const latest = latestVersion(j);
  if (!latest) return stop('hold — nothing to review');
  if (j.state !== 'in-review') {
    j.state = 'in-review';
    writeAutoJournal(j);
  }

  if (DRY_RUN) {
    log.warn(`[dry-run] would wait for QA — auto-approving v${latest.v}`, { iid });
    j.approval = { version: latest.v, by: 'dry-run', noteId: 0, at: new Date().toISOString() };
    j.state = 'approved';
    writeAutoJournal(j);
    logEvent('automation_approved', { iid, v: latest.v, by: 'dry-run' }, { runId: j.runId, phase: AUTOMATION_PHASE });
    return go;
  }

  const notes = await issueNotes(iid);
  if (!notes.ok || !notes.data) return stop(`hold — cannot read the ticket's notes (${notes.kind})`);
  for (const r of repliesAfter(notes.data, j.watermark)) {
    if (isApprovedReply(r.text) && !(r.user && ctx.approvers.includes(r.user))) {
      log.warn(`${tag(iid)} ignored an 'approved' from outside the qa list`, { user: r.user });
    }
  }
  const verdict = reviewVerdict(notes.data, {
    watermark: j.watermark, versionNoteId: latest.noteId ?? j.watermark, approvers: ctx.approvers,
  });

  if (verdict.verdict === 'pending') return stop(`v${latest.v} waiting on QA`);

  if (verdict.verdict === 'approved') {
    j.approval = { version: latest.v, by: verdict.by, noteId: verdict.noteId, at: verdict.at || new Date().toISOString() };
    j.state = 'approved';
    writeAutoJournal(j);
    logEvent('automation_approved', { iid, v: latest.v, by: verdict.by, noteId: verdict.noteId },
      { runId: j.runId, phase: AUTOMATION_PHASE });
    log.ok(`${tag(iid)} v${latest.v} approved by @${verdict.by}`);
    return go;
  }

  const authors = unique(verdict.notes.map((n) => n.author).filter(Boolean));
  const round = { afterVersion: latest.v, noteIds: verdict.notes.map((n) => n.id), authors };
  if (verdict.nearApprovalOnly) {
    // Nothing is approved and nothing needs writing: explain the one-word rule,
    // without a session. The round is consumed only once the note is up.
    const post = await postOnce(iid, 'nochange', String(verdict.maxId), noChangeBody({
      v: latest.v, authors, notes: [], nearApproval: true, maxNoteId: verdict.maxId,
    }), notes.data);
    if (!post.ok) return stop(`hold — could not post the no-change note (${post.error})`);
    j.feedbackRounds.push(round);
    j.watermark = Math.max(j.watermark, verdict.maxId);
    writeAutoJournal(j);
    logEvent('automation_feedback', { iid, v: latest.v, outcome: 'near-approval', authors },
      { runId: j.runId, phase: AUTOMATION_PHASE });
    log.info(`${tag(iid)} near-approval from ${authors.map((a) => `@${a}`).join(', ')} — explained the single-word rule`);
    return stop(`v${latest.v} near-approval — explained the single-word rule`);
  }

  j.feedbackRounds.push(round);
  j.watermark = Math.max(j.watermark, verdict.maxId);
  j.pendingFeedback = { afterVersion: latest.v, notes: verdict.notes, ignoredApproval: verdict.ignoredApproval };
  j.state = 'authoring';
  j.attempts = 0;
  j.freeRetries = 0;
  writeAutoJournal(j);
  logEvent('automation_feedback', { iid, v: latest.v, outcome: 'revise', authors, ignoredApproval: verdict.ignoredApproval },
    { runId: j.runId, phase: AUTOMATION_PHASE });
  log.info(`${tag(iid)} change request from ${authors.map((a) => `@${a}`).join(', ')} — revising v${latest.v}`);
  return go;
}

function saEmail(): string {
  try { return loadServiceAccount(googleServiceAccountFile()).client_email; } catch { return 'the service account in ONESHOT_GOOGLE_SA_FILE'; }
}

/** What a person should do about each sheet failure, in plain words (§5.7). */
function sheetAction(kind: SheetsFail): string {
  switch (kind) {
    case 'permission': return `Share the sheet as Editor with ${saEmail()}.`;
    case 'auth': return 'The service account key was refused. Check the key file ONESHOT_GOOGLE_SA_FILE names on the oneshot desk.';
    case 'notfound': return 'Check `automation.sheet.spreadsheetId` in config/project.json: the sheet was not found.';
    case 'layout': return 'Fix the rows or merged range named above (unmerge or move it), and oneshot writes the cases on its next pass.';
    case 'readback': return 'Check the rows named above and remove any partial block.';
    case 'client': return 'The Sheets API refused the request. An operator has to read the conductor log.';
    default: return 'Google Sheets has been failing for over an hour. Nothing needs doing on the ticket.';
  }
}

async function sheetFailed(ctx: Ctx, res: Extract<SheetsResult<SheetWriteResult>, { ok: false }>): Promise<StepResult> {
  const j = ctx.j!;
  const { iid } = ctx;
  const now = Date.now();
  const prev = j.sheetFailure;
  j.sheetFailure = { kind: res.kind, since: prev?.since ?? now, noted: prev?.noted ?? [] };
  const lasting = LASTING_SHEET_FAILURES.has(res.kind) || now - j.sheetFailure.since >= SHEET_NOTE_AFTER_MS;
  let reported = '';
  if (lasting && !j.sheetFailure.noted.includes(res.kind)) {
    const action = sheetAction(res.kind);
    const post = await postOnce(iid, 'sheet-failed', res.kind, sheetFailedBody({
      v: j.approval?.version ?? 0, kind: res.kind, reason: res.error, action,
    }));
    if (post.ok) {
      j.sheetFailure.noted.push(res.kind);
      reported = ' — reported on the ticket';
    }
    writeAutoJournal(j);
    await alertOnce(j, `sheet:${res.kind}`,
      `Oneshot approved the automation cases for #${iid} but could not write them to the sheet (${res.kind}): ${res.error}. ${action}`);
  }
  writeAutoJournal(j);
  logEvent('automation_hold', { iid, why: 'sheet', kind: res.kind, error: res.error.slice(0, 300) },
    { runId: j.runId, phase: AUTOMATION_PHASE });
  log.warn(`${tag(iid)} hold — the sheet write failed (${res.kind}): ${res.error}${reported}`);
  return stop(`hold — the sheet write failed (${res.kind})${reported}`);
}

/** The year the approval was GIVEN, so a late-December approval noticed in January lands in its own year's tab. */
function approvalYear(at: string): number {
  const y = new Date(at).getFullYear();
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

/**
 * `sheet`: readiness again, then the sheet (written and read back), then the
 * labels. The readiness re-check stops a ticket that was ready only because it
 * was closed, and was reopened during review, from being marked done. A sheet
 * already written and verified is not written again while the labels are
 * retried; a crash before that point re-runs the write, which finds its own
 * marks and sends only what is missing.
 */
async function stepSheet(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;
  const ap = j.approval;
  if (!ap) return stop('hold — approved without an approval record');

  const g = await gateOnReadiness(ctx, j, await checkReadiness(ctx), 'approved');
  if (!g.ready) return stop(g.did);

  if (!j.sheet) {
    const art = readVersion(iid, ap.version);
    if (!art) {
      log.error(`${tag(iid)} cases-v${ap.version}.json is missing — archive state/automation/${iid} to start over`);
      return stop(`hold — the approved v${ap.version} list is missing`);
    }
    const res = await writeApprovedCases({
      iid, title: ctx.issue.title, issueUrl: issueUrl(iid), module: art.module, cases: art.cases,
      year: approvalYear(ap.at),
    }, cfg.sheet, googleServiceAccountFile(), sheetOptions(iid));
    if (!res.ok) return sheetFailed(ctx, res);
    j.sheet = res.data;
    delete j.sheetFailure;
    writeAutoJournal(j);
    logEvent('automation_sheet_written', {
      iid, v: ap.version, moduleTab: res.data.moduleTab, blockRange: res.data.blockRange,
      trackerTab: res.data.trackerTab, trackerRow: res.data.trackerRow, alreadyThere: res.data.alreadyThere,
      created: res.data.created, dryRun: res.data.dryRun,
    }, { runId: j.runId, phase: AUTOMATION_PHASE });
    log.ok(`${tag(iid)} sheet written — '${res.data.moduleTab}' ${res.data.blockRange}, `
      + `'${res.data.trackerTab}' row ${res.data.trackerRow}${res.data.dryRun ? ' (dry run)' : ''}`);
  }

  const lab = await editIssueLabels(iid, doneLabelEdit(cfg, ctx.loop));
  if (!lab.ok) {
    log.warn(`${tag(iid)} the sheet is written, but the labels could not be changed (${lab.kind}) — retrying next tick`);
    return stop('hold — the labels could not be changed');
  }
  j.labelsDone = true;
  writeAutoJournal(j);
  return go;
}

/** `done-note`: the last note, marker-checked. Runs even with `Automation Done` present (§1.3). */
async function stepDoneNote(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid, cfg } = ctx;
  const ap = j.approval;
  const s = j.sheet;
  if (!ap || !s) return stop('hold — the done note needs the approval and the sheet result');
  const count = j.versions.find((x) => x.v === ap.version)?.count ?? 0;
  const edit = doneLabelEdit(cfg, ctx.loop);
  const post = await postOnce(iid, 'done', undefined, doneBody({
    v: ap.version, count, approvedBy: ap.by, removed: edit.remove, added: edit.add,
    sheet: {
      moduleTab: s.moduleTab, blockRange: s.blockRange, blockLink: s.blockLink, trackerTab: s.trackerTab,
      trackerRow: s.trackerRow, trackerLink: s.trackerLink, automationStatus: s.automationStatus,
    },
  }));
  if (!post.ok) {
    log.warn(`${tag(iid)} the done note could not be posted (${post.error}) — retrying next tick`);
    return stop('hold — the done note could not be posted');
  }
  j.doneNoteId = post.id;
  j.donePostedAt = Date.now();
  j.state = 'done';
  writeAutoJournal(j);
  logEvent('automation_done', { iid, v: ap.version, noteId: post.id, adopted: post.adopted },
    { runId: j.runId, phase: AUTOMATION_PHASE });
  log.ok(`${tag(iid)} done ✅ — v${ap.version} on '${s.moduleTab}', labels flipped`);
  return stop('done — sheet written, labels flipped, done note posted');
}

async function maxNoteId(iid: number): Promise<number | null> {
  const r = await issueNotes(iid);
  if (!r.ok || !r.data) return null;
  return r.data.reduce((m, n) => Math.max(m, n.id), 0);
}

/**
 * `stuck-poll`: post the stuck note until it is on the ticket, learn the
 * ticket's highest note id at that moment, and after that release only on a
 * QA approver's comment newer than it.
 */
async function stepStuckPoll(ctx: Ctx): Promise<StepResult> {
  const j = ctx.j!;
  const { iid } = ctx;
  const st = j.stuck;
  if (!st) {
    j.state = 'authoring';
    writeAutoJournal(j);
    return go;
  }
  if (st.notePostedAt === null) {
    const off = await switchedOff(ctx);
    if (off) return stop(`stuck — ${off}`);
    const post = await postOnce(iid, 'failed', st.fp, stuckBody(st.reason, st.fp, ctx.approvers));
    if (!post.ok) {
      log.warn(`${tag(iid)} stuck — the note could not be posted (${post.error}); retrying next tick`);
      return stop('stuck — note not posted yet');
    }
    st.notePostedAt = Date.now();
    st.sinceNoteId = await maxNoteId(iid);
    writeAutoJournal(j);
    log.warn(`${tag(iid)} stuck — ${st.reason}; a QA approver's comment retries it`);
    return stop('stuck — waiting for a QA approver to comment');
  }
  if (st.sinceNoteId === null) {
    // A null here would make every note on the ticket look newer. Learn it
    // first, and release nothing on this pass.
    st.sinceNoteId = await maxNoteId(iid);
    writeAutoJournal(j);
    return stop('stuck — waiting for a QA approver to comment');
  }
  if (DRY_RUN) return stop('stuck — a dry run never releases itself');
  const notes = await issueNotes(iid);
  if (!notes.ok || !notes.data) return stop(`stuck — cannot read the ticket's notes (${notes.kind})`);
  const release = stuckReleaseNote(notes.data, st, ctx.approvers, DRY_RUN);
  if (!release) return stop('stuck — waiting for a QA approver to comment');
  delete j.stuck;
  j.state = 'authoring';
  j.attempts = 0;
  j.freeRetries = 0;
  // The release comment ("retry") is consumed by the release: read by the
  // next tally, it would be a change request for the version it produced.
  if (j.versions.length) j.watermark = Math.max(j.watermark, release.id);
  writeAutoJournal(j);
  log.info(`${tag(iid)} released from stuck by @${release.user} — trying again`);
  return go;
}

function stepSkip(ctx: Ctx, why: string): StepResult {
  if (ctx.j?.state === 'done' && !ctx.issue.labels.includes(ctx.cfg.labels.done) && !finishedLogged.has(ctx.iid)) {
    finishedLogged.add(ctx.iid);
    log.info(`${tag(ctx.iid)} finished earlier — archive state/automation/${ctx.iid} and remove its sheet block to redo`);
  }
  return stop(why);
}

function runStep(ctx: Ctx, step: Step): Promise<StepResult> | StepResult {
  switch (step.kind) {
    case 'skip': return stepSkip(ctx, step.why);
    case 'hold': return stop(`hold — ${step.why}`);
    case 'check': return stepCheck(ctx, step.reason);
    case 'author': return stepAuthor(ctx, step.mode);
    case 'post': return stepPost(ctx, step.v);
    case 'label-review': return stepLabelReview(ctx, step.v);
    case 'review': return stepReview(ctx);
    case 'sheet': return stepSheet(ctx);
    case 'done-note': return stepDoneNote(ctx);
    case 'stuck-poll': return stepStuckPoll(ctx);
    default: return stop('hold — unknown step');
  }
}

/**
 * Step one ticket until it reaches a waiting point. The caller holds the
 * ticket's lock. Never throws for a GitLab, sheet or session failure — those
 * are holds — but a programming error does propagate to the tick's catch.
 */
export async function advanceTicket(issue: Issue, opts: AutomationOpts): Promise<AutomationOutcome> {
  const iid = issue.iid;
  let cfg: AutomationConfig;
  try {
    cfg = automationConfig();
  } catch (err) {
    return { iid, state: 'skipped', did: errText(err) };
  }
  const project = currentProjectKey();
  const ctx: Ctx = { iid, issue, opts, cfg, loop: loopLabel(), approvers: reviewersConfig().qa, j: readAutoJournal(iid) };
  if (ctx.j && ctx.j.project !== project) {
    const to = archiveAutoJournal(iid, ctx.j.runId);
    log.warn(`${tag(iid)} its journal was written for ${ctx.j.project ?? 'no project'}, not ${project ?? 'this one'} — `
      + `moved to ${to ?? '(nothing to move)'}; starting fresh`);
    ctx.j = null;
  }

  let did = 'nothing to do';
  for (let n = 0; ; n++) {
    if (opts.signal.aborted) { did = 'stopped for shutdown'; break; }
    // Before EVERY step, not only before a session: the writes that follow
    // one (the version note, the labels, the sheet) come up to half an hour
    // after it started, and the session itself has no tool PAUSE could deny.
    if (isPaused(opts)) { did = 'hold — paused (state/PAUSE)'; break; }
    if (n >= MAX_STEPS) {
      did = `stopped after ${MAX_STEPS} steps — continuing next tick`;
      log.warn(`${tag(iid)} ${did}`);
      break;
    }
    const step = nextStep(ctx.j, issue, {
      trigger: cfg.labels.trigger, done: cfg.labels.done, recheckMs: cfg.recheckMinutes * 60_000,
      now: Date.now(), project,
    });
    const res = await runStep(ctx, step);
    if (!res.cont) { did = res.did; break; }
  }
  return { iid, state: ctx.j?.state ?? 'skipped', did };
}

/** One advance under the ticket's lock. A lock someone else holds is a skip, not a failure. */
async function advanceLocked(issue: Issue, opts: AutomationOpts): Promise<AutomationOutcome> {
  const release = acquireTicketLock(issue.iid, opts.conductor);
  if (!release) return { iid: issue.iid, state: 'skipped', did: 'another conductor on this desk is advancing it' };
  try {
    return await advanceTicket(issue, opts);
  } finally {
    release();
  }
}

/**
 * One pass over every trigger-labelled ticket, sequentially: one session at a
 * time per process. Not awaited by the Loop's tick (index.ts kickAutomation).
 *
 * Also sweeps local journals that are approved, labels flipped, done note not
 * yet posted: they carry `Automation Done`, so the scan can no longer return
 * them, and without the sweep their last note would never be posted.
 */
export async function automationTick(opts: AutomationOpts): Promise<void> {
  if (!isReachable()) return;
  let cfg: AutomationConfig;
  try {
    cfg = automationConfig();
  } catch (err) {
    log.warn(`auto       ${errText(err)}`);
    return;
  }
  const loop = loopLabel();
  const res = await automationScan(cfg, loop);
  if (!res.ok || !res.data) {
    log.warn(`auto       could not scan for "${loop}" + "${cfg.labels.trigger}" tickets`, { kind: res.kind, status: res.status });
    return;
  }
  const { candidates } = res.data;
  const seen = new Set(candidates.map((i) => i.iid));
  for (const j of listAutoJournals()) {
    if (seen.has(j.iid) || j.state !== 'approved' || !j.labelsDone || j.donePostedAt != null) continue;
    const got = await getIssue(j.iid);
    if (got.ok && got.data) {
      candidates.push(got.data);
      seen.add(j.iid);
    }
  }

  for (const issue of candidates) {
    if (opts.signal.aborted || isPaused(opts)) break;
    try {
      const o = await advanceLocked(issue, opts);
      if (o.did.startsWith('another conductor')) log.info(`${tag(issue.iid)} skipped — ${o.did}`);
    } catch (err) {
      log.error(`${tag(issue.iid)} advance threw`, { error: errText(err) });
      logEvent('automation_threw', { iid: issue.iid, error: errText(err) });
    }
  }
}

/**
 * `--automation <iid>`: the same advance, under the same lock, for one ticket.
 * A ticket without the trigger label or the Loop's entry label is left alone
 * like the scan leaves it — unless it owes its done note, which nextStep puts
 * first (the finishing edit has already taken `Loop` off by then).
 */
export async function runAutomationOnce(iid: number, opts: AutomationOpts): Promise<AutomationOutcome> {
  let cfg: AutomationConfig;
  try {
    cfg = automationConfig();
  } catch (err) {
    return { iid, state: 'skipped', did: errText(err) };
  }
  const res = await getIssue(iid);
  if (!res.ok || !res.data) return { iid, state: 'skipped', did: `cannot read #${iid} from GitLab (${res.kind} ${res.status})` };
  const j = readAutoJournal(iid);
  const owesDoneNote = j?.state === 'approved' && j.labelsDone === true && j.donePostedAt == null;
  const labels = res.data.labels;
  const missing = [cfg.labels.trigger, loopLabel()].filter((l) => !labels.includes(l));
  if (missing.length && !owesDoneNote) {
    const names = missing.map((l) => `"${l}"`).join(' and ');
    return { iid, state: j?.state ?? 'skipped', did: `${names} ${missing.length > 1 ? 'are' : 'is'} not on #${iid} — nothing to do` };
  }
  return advanceLocked(res.data, opts);
}

/**
 * Problems that keep the mode off (Loop unaffected). Includes one read-only spreadsheets.get.
 * Each is a sentence saying what is wrong and, where there is one, what to do.
 */
export async function automationPreflight(): Promise<string[]> {
  const problems: string[] = [];
  let cfg: AutomationConfig | null = null;
  try {
    cfg = automationConfig();
  } catch (err) {
    problems.push(errText(err));
  }
  const saFile = googleServiceAccountFile();
  let email: string | null = null;
  try {
    email = loadServiceAccount(saFile).client_email;
  } catch (err) {
    problems.push(`${errText(err)} — set ONESHOT_GOOGLE_SA_FILE to the service account's key file`);
  }
  const phase = phaseByName(AUTOMATION_PHASE);
  if (!phase) problems.push(`config/phases.json has no '${AUTOMATION_PHASE}' phase (or ONESHOT_SKIP_PHASES removes it)`);
  else if (phase.kind !== 'session') problems.push(`the '${AUTOMATION_PHASE}' phase must be a session phase`);
  if (!schemaFor(AUTOMATION_PHASE)) problems.push(`no output schema is registered for '${AUTOMATION_PHASE}' (src/conductor/schemas.ts)`);
  if (!existsSync(join(ROOT, 'hooks', 'automation-ready.cjs'))) {
    problems.push('hooks/automation-ready.cjs is missing, so no ticket can be proven ready');
  }
  if (!reviewersConfig().qa.length) problems.push('config/reviewers.json lists no qa approvers, so no version could ever be approved');
  try {
    readToken();
  } catch (err) {
    problems.push(`${errText(err)} — the conductor reads the ticket and the merged change with it`);
  }
  if (cfg && email) {
    const s = await getSpreadsheet(cfg.sheet.spreadsheetId, saFile);
    if (!s.ok) {
      problems.push(`cannot read sheet ${cfg.sheet.spreadsheetId} as ${email} (${s.kind}): ${s.error}`
        + (s.kind === 'permission' ? ` — share the sheet as Editor with ${email}` : ''));
    }
  }
  return problems;
}

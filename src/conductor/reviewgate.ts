/**
 * The opt-in `Review` label's two SESSION-side pause points: plan approval
 * (between phase 2 `plan` and phase 3 `implement`) and test-case approval
 * (between phase 4 `testcases` and phase 5 `review`). The merge gate for phase
 * 9 is pure code and lives in codephases.ts instead, for the same reason
 * `merge` itself is code: no model should be involved in a gate that decides
 * whether the pipeline may proceed.
 *
 * The test-case gate sits BEFORE `review`, not after `qa`, and that position is
 * the whole point of it. Approving a case list while the branch is still
 * unreviewed and unmerged means an edge case a reviewer adds is tested by this
 * run — it flows into `review`, the MR and `qa`. The same approval taken after
 * `qa` would arrive once the code had already shipped, where feedback can only
 * become a follow-up ticket. A gate that cannot change the thing it guards is
 * decoration.
 *
 * GITLAB IS THE APPROVAL CHANNEL, and Slack is where the ask is HEARD. A gate
 * posts its request as a ticket comment (`addIssueNote`) and polls that
 * ticket's comments for a reply from a named reviewer. It also posts the ask
 * into the run's Slack thread AND broadcasts it to the channel, @mentioning
 * the group that owns the gate — because a ticket comment notifies only
 * whoever already subscribed to the ticket, which is how a run ends up parked
 * for a day on a reviewer who never knew they were being waited on.
 *
 * That split is deliberate and is not a second approval channel. Slack is
 * write-only here: nothing is ever read back out of it, so a Slack that is
 * down, unconfigured, or missing `users:read.email` costs a notification and
 * never a verdict. The run parks either way and resolves the moment the
 * ticket answers.
 *
 * That reverses the previous version, which asked and read in Slack. The
 * reason is authorisation, not preference: approval is now restricted to two
 * named groups (config/reviewers.json), and the only identity a reply carries
 * in Slack is a Slack user id, which cannot be matched against the GitLab
 * usernames the people asking for this gate actually gave. Reading the verdict
 * where the reviewers already are — on the ticket, signed by their GitLab
 * account — is what makes "only these people may approve" enforceable rather
 * than advisory. It also collapses two systems into one: the request, every
 * feedback round and the audit record now all live on the ticket, in order.
 *
 * WHO may approve is per-gate, not global: `plan` is a dev sign-off and
 * `testcases` is a QA sign-off (GATE_ROLE below). A comment from outside the
 * relevant group is not an approval AND is not gating feedback — it is logged
 * and ignored, so ordinary ticket chatter cannot knock a run into a revision
 * cycle.
 *
 * This file is deliberately NOT a polling loop. A check is one quick GitLab
 * read, and when nothing has happened yet it says so and the CALLER parks the
 * whole run (`RunJournal.status = 'parked'`) rather than sleeping here. That
 * is what makes "poll cadence follows the existing tick loop, no separate
 * polling process" literally true: the only thing that ever re-invokes this
 * check is the conductor's own `TICK_MS` scan re-claiming the ticket and
 * resuming, exactly like any other resumable run. It also means a parked
 * run holds no dispatch slot, no port and no exclusivity between checks —
 * every other ticket, Review-labelled or not, pipelines around it.
 *
 * Zero cap on feedback rounds is structural, not a large number standing in
 * for infinity: `ReviewGateState.feedback` is an array appended to and never
 * trimmed, and nothing here ever refuses a round.
 *
 * The reviewers must be MEMBERS of the project, not merely active accounts.
 * A non-member cannot comment on the ticket at all, so a gate naming one waits
 * for a reply that can never be posted — the same silent wedge as an empty
 * list, arriving later and looking exactly like a reviewer who has not read it
 * yet. config/reviewers.json records when its list was last checked.
 */
import { DRY_RUN, phases, projectConfig, reviewersConfig } from '../lib/config.js';
import {
  gateSubjectDigest, readArtifact, readJournal, updateJournal, writeArtifact,
  type ReviewGateState, type RunJournal,
} from '../lib/artifacts.js';
import {
  addIssueNote, issueNotes, issueUrl, swapLabel, uploadFile, type Upload,
} from '../lib/gitlab.js';
import { slackEnabled, thread, userIdForEmail, userIdForHandle } from '../lib/slack.js';
import { isMachineNote } from '../lib/claims.js';
import { log } from '../lib/log.js';
import { codeSpan, mdText, tableCell } from '../lib/gitlabmd.js';
import type { DesignArtifact, TestCase } from '../phases/types.js';
import { parseEdgeCases } from './edgecases.js';
import { MAX_UPLOAD_BYTES, mimeFor } from '../lib/publish.js';
import { artifactDir } from '../lib/config.js';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Gate = 'plan' | 'testcases' | 'design';
export type GateVerdict = 'approved' | 'feedback' | 'pending' | 'unavailable';

export interface GateResult {
  verdict: GateVerdict;
  /**
   * Every non-`approved` reply read this round. Set on 'feedback', and ALSO
   * on 'approved' when replies preceded the sign-off — a reviewer who lists
   * two edge cases and then types `approved` said both things, and dropping
   * the first half because the second one arrived is how a gate loses exactly
   * the content it exists to collect.
   */
  feedback?: string;
}

/** Whether this ticket opted into the review gates at all. Additive: absent label, no gates. */
export function reviewLabelPresent(labels: string[]): boolean {
  const label = projectConfig().labels.review;
  return Boolean(label) && labels.includes(label);
}

/**
 * Gates on every run, regardless of label or path.
 *
 * The label and the path list remain the finer-grained answer and are deliberately
 * left in place: they are what still gates the tickets that matter when this is
 * switched back off, and turning it off should not silently ungate `apps/auth/`.
 */
export function reviewAllRuns(): boolean {
  return projectConfig().reviewAllRuns === true;
}

/**
 * Which of `highScrutinyPaths` this run's files touch.
 *
 * The `Review` label is applied by a person, so it is forgettable — and the
 * tickets worth pausing on are precisely the ones nobody thinks to label. A
 * fix to payroll or leaves is not less consequential because it arrived as an
 * ordinary bug report. So the gates key off what the run actually TOUCHES as
 * well as off the label.
 *
 * Substring matching against repo-relative paths, deliberately: `apps/payroll/`
 * should catch everything beneath it, and a pattern list is easier to audit
 * than a set of regexes nobody can read. Configured per project, and derived at
 * load from the `paths` of every module in config/risk-modules.json — dropping a
 * module's `paths` there is what disarms it.
 */
export function highScrutinyHits(files: string[]): string[] {
  const guarded = projectConfig().highScrutinyPaths ?? [];
  if (!guarded.length) return [];
  const hit = new Set<string>();
  for (const f of files) {
    for (const g of guarded) if (f.includes(g)) hit.add(g);
  }
  return [...hit].sort();
}

/** Every file this run has said it will touch, or has touched. */
export function declaredFiles(
  plan: Record<string, unknown> | null, implemented: Record<string, unknown> | null,
): string[] {
  const steps = Array.isArray(plan?.steps) ? (plan.steps as Array<{ files?: unknown }>) : [];
  const planned = steps.flatMap((s) => (Array.isArray(s.files) ? s.files.map(String) : []));
  const changed = Array.isArray(implemented?.filesChanged)
    ? (implemented.filesChanged as unknown[]).map(String) : [];
  return [...planned, ...changed];
}

export interface GateTrigger {
  on: boolean;
  /** Non-empty when the guarded paths, rather than the label, armed the gates. */
  hits: string[];
}

/**
 * Do the gates apply to this run? Label OR guarded paths — never label alone.
 *
 * Evaluated fresh at each gate rather than once per run, because the answer
 * changes as the run learns: at the plan gate only the plan's declared files
 * exist, and by the test-case gate `implement` has reported what it really
 * touched. A plan that swore off payroll and a diff that edited it anyway is
 * exactly the case worth catching, and only the later evaluation sees it.
 */
export function gatesApply(labels: string[], files: string[]): GateTrigger {
  const hits = highScrutinyHits(files);
  return { on: reviewAllRuns() || reviewLabelPresent(labels) || hits.length > 0, hits };
}

/** The one line a gate request needs about why it is asking. */
export function triggerLine(trigger: GateTrigger): string {
  if (!trigger.hits.length) {
    return reviewAllRuns()
      ? 'The review gates are on for every run (`reviewAllRuns` in config/project.json).'
      : 'This ticket carries **Review**.';
  }
  return 'This run touches guarded paths — **' + trigger.hits.join('**, **') + '** — so the review '
    + 'gates apply whether or not the ticket carries the `Review` label.';
}

function isApprovedReply(text: string): boolean {
  // Exact match, case-insensitive, trimmed — deliberately NOT a substring
  // test. "approved, but see my comment above" is feedback, not a sign-off:
  // the whole point of requiring the bare word is that a reviewer who wants
  // changes cannot accidentally also approve them.
  return text.trim().toLowerCase() === 'approved';
}

/**
 * Which group owns each gate.
 *
 * `plan` is a dev decision — it settles what gets built, before any code
 * exists. `testcases` is a QA decision — it settles what will be verified, at
 * the last point where an added case is still tested by this run. Splitting
 * them is the difference between "a human looked" and "the right human
 * looked": one list for both would let a reviewer sign off on the half of the
 * pipeline they were not asked to own.
 */
export type ReviewRole = 'dev' | 'qa';
const GATE_ROLE: Record<Gate, ReviewRole> = { plan: 'dev', testcases: 'qa', design: 'dev' };

/**
 * Does the DESIGN gate apply to this run?
 *
 * Its own label, and only its own label — not `Review`, not `reviewAllRuns`,
 * not the guarded paths. The three are answers to a different question: how
 * much scrutiny does this CODE need. `Design` answers "the UI has to be agreed
 * before it is built", which is a decision about the work rather than about
 * the risk, and a team that switches `reviewAllRuns` off has not thereby said
 * designs may ship unreviewed.
 *
 * It follows that the gate cannot arm on a ticket the `design` phase never ran
 * on — the same label decides both (`labelGated` in config/phases.json), so
 * the two can only agree.
 */
export function designGateApplies(labels: string[]): boolean {
  const phase = phases().find((p) => p.name === 'design');
  const label = phase?.labelGated;
  if (!label) return false;
  const carried = new Set(labels.map((l) => l.toLowerCase()));
  return carried.has(label.toLowerCase());
}

/** The GitLab usernames permitted to resolve this gate. */
function approversFor(gate: Gate): string[] {
  return reviewersConfig()[GATE_ROLE[gate]] ?? [];
}

/**
 * The board-only marker for the `testcases` gate — `labels.testcaseReview`,
 * empty/off by default. `plan` has no equivalent: there is nothing on a
 * board to tell apart there, since 'awaiting plan approval' is already the
 * only reason a run parks before `implement`. `testcases` is where a QA
 * hold needs to read differently from every other parked/blocked reason, so
 * only that gate carries one.
 */
function boardLabel(gate: Gate): string | null {
  const { testcaseReview, designReview } = projectConfig().labels;
  if (gate === 'testcases') return testcaseReview || null;
  // `design` earns one for the same reason `testcases` does: a board that
  // cannot tell 'waiting on a design sign-off' from every other parked reason
  // sends somebody to read a journal to find out. Optional and off unless the
  // label is configured AND exists on the project, same as the other.
  if (gate === 'design') return designReview || null;
  return null;
}

/**
 * Swap the board label on or off. Best-effort: a label is a board convenience,
 * never part of the verdict, so a failed swap must not fail the gate check it
 * rides along with. Checked by result rather than caught — swapLabel reports
 * every HTTP, timeout and network failure as `ok: false` and never throws, so
 * a try/catch here would leave the failure silent.
 *
 * Turning it off puts the entry label back in the same write. A QA verdict —
 * approval or feedback — hands the ticket back to the pipeline, and the board
 * should say `Loop` whether or not someone took it off while the ticket sat
 * with QA. swapLabel never duplicates a label, so this is a no-op when `Loop`
 * is already there.
 */
async function setBoardLabel(iid: number, gate: Gate, on: boolean): Promise<void> {
  const label = boardLabel(gate);
  if (!label) return;
  const { entry } = projectConfig().labels;
  const res = await swapLabel(iid, on ? [] : [label], on ? [label] : [entry]);
  if (!res.ok) {
    log.warn(`could not swap board label '${label}' on #${iid}`, { status: res.status, error: res.error });
  }
}

/**
 * A ticket comment, reduced to the three fields a verdict is decided on.
 *
 * `user` is a GitLab username rather than the Slack id the previous version
 * matched, and `id` replaces the Slack ts as the watermark — note ids are
 * monotonic per project, so "strictly after the request" is an integer
 * comparison rather than a string one.
 */
interface NoteReply { id: number; text: string; user: string | null }

/**
 * Whether this comment's author may resolve the gate.
 *
 * There is no fall-open branch. An empty list is rejected earlier, by
 * `checkApprovalGate`, as a configuration mistake — because a gate that
 * approves itself when nobody is configured is strictly worse than one that
 * refuses to run, and the previous version's "empty means anyone" default is
 * exactly the behaviour this change exists to remove.
 */
function mayApprove(reply: NoteReply, gate: Gate): boolean {
  return reply.user !== null && approversFor(gate).includes(reply.user);
}

function blankState(): ReviewGateState {
  return { requestTs: null, requestNoteId: null, approved: false, feedback: [] };
}

const GATE_STATE: Record<Gate, keyof Pick<RunJournal, 'planApproval' | 'testcasesApproval' | 'designApproval'>> = {
  plan: 'planApproval',
  testcases: 'testcasesApproval',
  design: 'designApproval',
};

function stateOf(j: RunJournal, gate: Gate): ReviewGateState {
  return j[GATE_STATE[gate]] ?? blankState();
}

function persist(iid: number, gate: Gate, state: ReviewGateState): RunJournal | null {
  return updateJournal(iid, { [GATE_STATE[gate]]: state });
}

/**
 * Clear a gate's sign-off so the next check posts a FRESH request.
 *
 * Re-arming by flipping `approved` alone is not enough and fails in the worst
 * possible direction: the gate keys off `requestNoteId`, so it would poll the
 * PREVIOUS request note, find the `approved` reply still sitting on it, and
 * approve the rewritten artifact against a sign-off given for the old one --
 * stamping a fresh digest on it and making the drift undetectable from then on.
 * The note id has to go with the verdict.
 *
 * Feedback history is kept: the reviewer's earlier rounds still apply to the
 * artifact being redrawn, and dropping them would send the next round in blind.
 */
export function rearmGate(iid: number, gate: Gate): RunJournal | null {
  const j = readJournal(iid);
  const prior = j ? stateOf(j, gate) : blankState();
  return persist(iid, gate, {
    requestTs: null, requestNoteId: null, approved: false, feedback: prior.feedback,
  });
}

export interface CheckGateOpts {
  iid: number;
  gate: Gate;
  /**
   * Posted as a ticket comment the moment this gate first arms, or re-arms
   * after a feedback round. Built fresh by the caller on every check (it
   * embeds the current plan, or the current test-case list), never cached
   * here.
   */
  requestBody: string;
  /**
   * Invoked once, exactly on the transition into 'approved' — the caller's
   * chance to leave the ticket its audit record (`addIssueNote`) now that the
   * decision has been made. Distinct from the request comment above: that one
   * asks, this one records what was agreed, so the ticket reads in order.
   */
  /**
   * The artifact this gate is asking a human to sign off on.
   *
   * Digested and stamped onto the gate state when the approval lands, so a
   * later rewrite of that artifact can be told apart from the one that was
   * actually approved. Omit it and the gate behaves exactly as before.
   */
  subject?: unknown;
  onApproved?: () => Promise<void>;
  /**
   * Invoked with the round's non-`approved` replies, BEFORE `onApproved` —
   * so a caller that folds feedback into an artifact (the test-case gate appending
   * edge cases to testcases.json) has already done so by the time the audit
   * record of what was approved is built from that same artifact.
   */
  onFeedback?: (feedback: string) => Promise<void>;
  /**
   * Why the gates armed, for the Slack ask only — the ticket comment already
   * carries `triggerLine(trigger)` inside `requestBody`. Passed as the struct
   * rather than the rendered line because the two renderings differ: that one
   * is GitLab Markdown and a full sentence, this one is Slack mrkdwn and a
   * clause.
   */
  trigger?: GateTrigger;
  /**
   * Files uploaded with the request comment, every time this gate arms.
   *
   * The `design` gate is the reason this exists: what it asks a reviewer to
   * approve is pictures, none of which
   * survive being described in a string. They are re-uploaded on every round
   * rather than cached, which is not waste — a round exists precisely because
   * the screens changed, and a request carrying the PREVIOUS round's
   * screenshots is worse than one carrying none.
   *
   * Not routed through lib/publish.ts, which posts each key exactly once by
   * design (`journal.published` is the lock). A gate that re-arms needs the
   * opposite guarantee.
   */
  attachments?: GateAttachment[];
}

export interface GateAttachment { name: string; content: Buffer | string; mime: string }

/**
 * Upload what the request carries and return the markdown that renders it.
 *
 * Best-effort per file: an attachment that will not upload costs that
 * attachment and not the gate. The alternative — refusing to arm — would park
 * the run in silence over a failed image, which is the one outcome worse than
 * a request with a picture missing. The failure is logged and the body says
 * so, so a reviewer looking at four screenshots where the text promised five
 * is told why rather than left to wonder.
 */
async function uploadAll(iid: number, attachments: GateAttachment[]): Promise<string[]> {
  const links: string[] = [];
  for (const a of attachments) {
    const up = await uploadFile(a.name, a.content, a.mime);
    if (!up.ok || !up.data) {
      log.warn(`gate: upload failed for ${a.name}`, { iid, error: up.error?.slice(0, 120) });
      continue;
    }
    links.push((up.data as Upload).markdown);
  }
  return links;
}

/**
 * One check of one gate. Never sleeps, never loops — see the file header.
 *
 * DRY_RUN auto-approves: a dry run is "watch the pipeline drive a real ticket
 * without touching it," and a reviewer's comment is exactly the human interaction
 * DRY_RUN exists to suppress, so requiring a real one here would just wedge
 * the dry run forever waiting for something it can never ask for.
 */
export async function checkApprovalGate(opts: CheckGateOpts): Promise<GateResult> {
  const { iid, gate, requestBody, subject, onApproved, onFeedback } = opts;

  if (DRY_RUN) {
    log.warn(`[dry-run] would pause at the '${gate}' review gate — auto-approving`, { iid });
    return { verdict: 'approved' };
  }

  // Nobody configured to approve is a configuration mistake, and 'pending'
  // would be a lie: no amount of waiting produces a sign-off from an empty
  // list. A park swaps no label and alerts nobody, so parking here is a run
  // that waits forever in silence. Say so and let the caller BLOCK — a
  // configuration mistake needs the person who can fix it.
  const approvers = approversFor(gate);
  if (!approvers.length) {
    log.warn(`no ${GATE_ROLE[gate]} reviewers in config/reviewers.json — '${gate}' gate cannot be satisfied`, { iid });
    return { verdict: 'unavailable' };
  }

  const journal = readJournal(iid);
  if (!journal) return { verdict: 'pending' };

  let state = stateOf(journal, gate);

  // requestNoteId, never requestTs: a journal written before the gates moved
  // to GitLab carries a Slack ts here, and treating that as a note id would
  // compare every note against a number no note will ever exceed. Absent
  // means "not armed on the ticket yet", which re-asks — the only safe read.
  if (state.requestNoteId == null) {
    const links = opts.attachments?.length ? await uploadAll(iid, opts.attachments) : [];
    const missing = (opts.attachments?.length ?? 0) - links.length;
    const body = `${requestBody}`
      + (links.length ? `\n\n${links.join('\n\n')}` : '')
      + (missing > 0 ? `\n\n_${missing} attachment(s) could not be uploaded to GitLab._` : '');
    const posted = await addIssueNote(iid, body);
    if (!posted.ok || !posted.data) {
      log.warn(`${gate} approval request could not be posted to the ticket — will retry next tick`, { iid });
      return { verdict: 'pending' };
    }
    state = { ...state, requestNoteId: posted.data.id };
    persist(iid, gate, state);
    await setBoardLabel(iid, gate, true);
    // Broadcast: the dev or QA who has to act on this is not the person
    // watching this run's thread, and a thread reply is invisible to them.
    // Once per round, on the transition into 'armed' — every following tick
    // takes the read path below and posts nothing, which is what keeps a
    // gate that sits pending for a day from being a ping every minute.
    const mentions = await mentionsFor(gate);
    await notifySlack(journal, gateAskText(journal, gate, posted.data.id, mentions, opts.trigger), true);
    log.phase(`${gate} approval requested on #${iid}`, {
      note: posted.data.id, mentioned: mentions ? mentions.split(' ').length : 0,
    });
    return { verdict: 'pending' };
  }

  const notes = await issueNotes(iid);
  if (!notes.ok || !notes.data) {
    log.warn(`${gate} gate could not read the ticket's comments — will retry next tick`, { iid });
    return { verdict: 'pending' };
  }

  const since = state.requestNoteId;
  const replies: NoteReply[] = notes.data
    // Strictly after the standing request, so a round never re-reads the
    // previous round's replies — and never reads the request itself.
    .filter((n) => n.id > since)
    // GitLab's own notes (label swaps, assignments) are board noise, and
    // Oneshot's audit records are its own voice; neither is a human verdict.
    .filter((n) => n.system !== true)
    // A claim note is an ordinary comment, so `system` does not catch it. On a
    // desk whose token belongs to a listed reviewer it therefore read as that
    // reviewer speaking — which is how run 29 approved-and-revised against its
    // own fleet. Anything carrying an oneshot marker is this pipeline talking.
    .filter((n) => !isMachineNote(n.body))
    .map((n) => ({ id: n.id, text: n.body ?? '', user: n.author?.username ?? null }));

  for (const r of replies) {
    if (isApprovedReply(r.text) && !mayApprove(r, gate)) {
      log.warn(`${gate} gate ignored an 'approved' from outside the ${GATE_ROLE[gate]} list`, { iid, user: r.user });
    }
  }

  // Only the owning group can move this gate — in either direction. Letting an
  // outsider's comment count as feedback would let ordinary ticket chatter
  // knock the run into a revision cycle nobody asked for, which is the same
  // authority leak as an unauthorised approval, just quieter.
  const fromReviewers = replies.filter((r) => mayApprove(r, gate));

  const approvedAt = fromReviewers.findIndex((r) => isApprovedReply(r.text));

  // Replies BEFORE the sign-off are the round's feedback; an `approved` is
  // never also feedback, whoever sent it.
  const feedback = (approvedAt === -1 ? fromReviewers : fromReviewers.slice(0, approvedAt))
    .filter((r) => !isApprovedReply(r.text))
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join('\n');

  if (feedback && onFeedback) await onFeedback(feedback);

  if (approvedAt !== -1) {
    const approver = fromReviewers[approvedAt]?.user ?? '(unknown)';
    state = {
      ...state,
      approved: true,
      feedback: feedback ? [...state.feedback, feedback] : state.feedback,
      ...(subject === undefined ? {} : { approvedDigest: gateSubjectDigest(subject) }),
    };
    persist(iid, gate, state);
    await setBoardLabel(iid, gate, false);
    if (onApproved) await onApproved();
    await notifySlack(
      journal, gateApprovedText(journal, gate, await mentionOrName(approver)), true,
    );
    log.ok(`${gate} approved on #${iid}`, { by: approver });
    return { verdict: 'approved', feedback: feedback || undefined };
  }

  if (feedback) {
    // requestNoteId resets to null: the NEXT check re-arms with a fresh
    // request comment, so the reply that follows the revision is measured
    // from there rather than from the round that just ended.
    state = {
      ...state, requestNoteId: null, approved: false, feedback: [...state.feedback, feedback],
    };
    persist(iid, gate, state);
    // Feedback is a verdict too: QA has answered and the ticket is back with
    // the pipeline. The label returns when the next check re-arms the gate
    // with a fresh request for the revised list.
    await setBoardLabel(iid, gate, false);
    log.phase(`${gate} feedback received on #${iid}`, { rounds: state.feedback.length });
    return { verdict: 'feedback', feedback };
  }

  return { verdict: 'pending' };
}

/**
 * Tell Slack a gate moved. Best-effort by construction.
 *
 * Every failure path is a no-op: Slack off, no thread on this run, or a post
 * that simply does not land. None of them can affect the verdict, because the
 * verdict was already decided on the ticket before this is called. That is the
 * entire reason the channel moved — a notification that cannot block is worth
 * having, and the previous version's read-side dependency was not.
 *
 * `broadcast` puts the message in the CHANNEL as well as the thread. Both of
 * a gate's two moments take it: the ask, because the people who must act are
 * by definition not the person watching this run's thread; and the
 * resolution, because a broadcast ask that is never visibly closed leaves the
 * channel showing a standing request long after it was answered. Nothing else
 * this file posts broadcasts.
 */
async function notifySlack(
  journal: RunJournal, text: string, broadcast = false,
): Promise<void> {
  if (!slackEnabled()) return;
  const ts = journal.slackTs ?? null;
  if (ts === null) return;
  try { await thread(ts, text, { broadcast }); } catch { /* a missed heads-up is not a gate failure */ }
}

/**
 * `<@U…>` for every reviewer who owns this gate, space-separated.
 *
 * Slack renders an @mention from a member id and from nothing else, so a
 * GitLab username in the text would be inert — and inertly so, which is the
 * failure worth designing against here: an approval request that LOOKS
 * addressed but notifies nobody is why a run sits parked for a day. The
 * usernames are completed to work addresses (`reviewersConfig().emailDomain`)
 * and resolved through Slack.
 *
 * Two routes, tried in order, because they need different scopes:
 *
 * 1. The SLACK HANDLE, which at Arbisoft is character-identical to the GitLab
 *    username — `arsal.tariq` is `@arsal.tariq` in both. Exact, and needs only
 *    `users:read`, which the bot token already carries. This is what actually
 *    resolves today.
 * 2. The work email (`emailDomain`), via `users.lookupByEmail`. Needs
 *    `users:read.email`, a scope a human must grant in the Slack console.
 *    Kept as a fallback for anyone whose handle does not match the convention;
 *    it costs one call per unresolved name and none at all when route 1 hits.
 *
 * Returns an empty string when nothing resolves. The caller then posts an
 * unaddressed request rather than none: the channel still learns the run is
 * waiting, and `doctor` is where the unresolvable name gets reported, not a
 * run that quietly stops notifying.
 *
 * Both routes cache per process, so a gate that asks again after a feedback
 * round costs no further lookups.
 */
/**
 * A reviewer's Slack member id, by the cheapest route that works.
 *
 * 1. PINNED (`slackIds` in config/reviewers.json) — no network at all, so the
 *    one message that must carry a mention cannot lose it to a rate limit.
 * 2. HANDLE — at Arbisoft the Slack handle equals the GitLab username, so a
 *    reviewer added without a pinned id still gets mentioned.
 * 3. EMAIL — only if `users:read.email` was ever granted; dormant otherwise.
 */
async function slackIdFor(username: string): Promise<string | null> {
  const { emailDomain, slackIds } = reviewersConfig();
  const pinned = slackIds[username];
  if (pinned) return pinned;
  return (await userIdForHandle(username))
    ?? (emailDomain ? await userIdForEmail(`${username}@${emailDomain}`) : null);
}

async function mentionsFor(gate: Gate): Promise<string> {
  const ids = await Promise.all(approversFor(gate).map(slackIdFor));
  return ids.filter((id): id is string => Boolean(id)).map((id) => `<@${id}>`).join(' ');
}

/**
 * One person, named in a way Slack will light up — the approver on the
 * resolution message.
 *
 * Falls back to the bare username in a code span, which is what this used to
 * render unconditionally. That fallback is the ONLY reason this is not just
 * `slackIdFor`: an ask that cannot mention anyone still has to say who it is
 * waiting on, and a record of a decision still has to say who made it.
 */
async function mentionOrName(username: string): Promise<string> {
  const id = await slackIdFor(username);
  return id ? `<@${id}>` : `\`${username}\``;
}

/**
 * SLACK mrkdwn, not GitLab Markdown — the mirror of the warning on
 * `renderPlanForTicket`, and just as easy to get backwards. `**bold**` shows
 * its asterisks here, and a bare URL is written `<url|text>`.
 *
 * Deliberately short. The plan or the case list is already on the ticket in
 * full, and this message's whole job is to get the right person to open it —
 * duplicating the content into Slack would mean two renderings of the same
 * thing that can disagree, and the one people would act on is the one that is
 * not authoritative.
 */
/**
 * A ticket title, made safe to use as the LABEL half of Slack's `<url|label>`
 * link syntax.
 *
 * Slack reserves `&`, `<` and `>` in message text, and `|` additionally
 * terminates the label inside a link — so a ticket called
 * "Payroll | increments not applied" would render as a link reading
 * "#123 Payroll" with the rest spilled out, and one containing `<` can break
 * the link outright. Titles are written by whoever opened the issue, so this
 * is data, not a constant, and the gate ask is the one message that puts a
 * title inside a link label rather than beside one.
 */
function linkLabel(title: string): string {
  return title
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\u2758');
}

/**
 * Each gate's three variable words: what is up for approval, what approving
 * releases the run into, and what a non-`approved` comment does instead.
 *
 * A table rather than the ternaries this used to be — with two gates those
 * read fine, and with three they become a chain where the third case is
 * whatever the second one is not.
 */
const ASK_WORDS: Record<Gate, { what: string; next: string; other: string }> = {
  plan: { what: 'the plan', next: '`implement`', other: 'feedback to have the plan revised' },
  testcases: { what: 'the test-case list', next: '`review`', other: 'edge case(s) to add to the list' },
  design: {
    what: 'the proposed design',
    next: '`plan`',
    other: 'what to change, to have the design redrawn',
  },
};

export function gateAskText(
  journal: RunJournal, gate: Gate, noteId: number, mentions: string, trigger?: GateTrigger,
): string {
  const role = GATE_ROLE[gate].toUpperCase();
  const { what, next, other } = ASK_WORDS[gate];
  const link = `<${issueUrl(journal.iid)}#note_${noteId}|#${journal.iid} ${linkLabel(journal.title)}>`;
  const why = trigger?.hits.length
    ? ` — armed by guarded paths (${trigger.hits.join(', ')})`
    : '';
  const who = mentions || `_${role} reviewers (${approversFor(gate).join(', ') || 'nobody configured'})_`;

  return `:pause_button: *${role} approval needed* on ${link}${why}\n` +
    `${who} — ${what} is posted on the ticket. Comment *\`approved\`* there to release the run ` +
    `into ${next}, or comment ${other}.\n` +
    '_Reply on the ticket, not here — this run reads its verdict from GitLab._';
}

/**
 * The other half of the pair: the ask's resolution.
 *
 * Broadcast like the ask, and for the ask's sake rather than its own — the
 * channel was shown a request to act, so it has to be shown that the request
 * is closed, or it keeps displaying a standing ask that was answered hours
 * ago. Named rather than inlined at the call site so both messages a gate can
 * put in the channel render through one reviewable pair.
 *
 * `approver` arrives already rendered — `<@U…>` where the person resolved, a
 * code-spanned username where they did not (`mentionOrName`). Same division
 * as `gateAskText`'s `mentions`: this stays a pure string builder, and every
 * Slack lookup happens before it is called.
 */
export function gateApprovedText(journal: RunJournal, gate: Gate, approver: string): string {
  return `:white_check_mark: *${gate} approved* by ${approver} on `
    + `<${issueUrl(journal.iid)}|#${journal.iid} ${linkLabel(journal.title)}> — the run continues.`;
}

// -------------------------------------------------------------- plan gate

interface PlanStep { n: number; what: string; files: string[]; layer: string }

/** The plan artifact, read as the fields this renderer actually wants — same shape as `sField`/`aField` in codephases.ts. */
function planStr(plan: Record<string, unknown> | null, key: string): string | null {
  const v = plan?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function planSteps(plan: Record<string, unknown> | null): PlanStep[] {
  const v = plan?.steps;
  return Array.isArray(v) ? (v as PlanStep[]) : [];
}

type PlanListKey = 'risks' | 'openQuestions' | 'outOfScope';

function planList(plan: Record<string, unknown> | null, key: PlanListKey): string[] {
  const v = plan?.[key];
  return Array.isArray(v) ? v.map(String) : [];
}

/**
 * Every free-text field below is coerced the same way `planList` coerces its
 * items, and for a harder reason than tidiness: `mdText` calls `.replace` on
 * what it is handed, so one absent or numeric field throws a TypeError. The
 * throw does not stay local — `planApprovalRequestBody` is called straight in
 * `runner.ts`'s implement-phase gate with no try/catch, so a half-written
 * plan.json takes down the whole phase, not just the comment it was rendering.
 */
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

interface AcCoverage { criterion: string; coveredBy: string; status: string; note: string }

/** Absent on plans written before the field existed — a resumed run's plan.json reads as empty, not as a crash. */
function planCoverage(plan: Record<string, unknown> | null): AcCoverage[] {
  const v = plan?.acceptanceCoverage;
  if (!Array.isArray(v)) return [];
  return (v as AcCoverage[])
    .filter((c) => c && typeof c.criterion === 'string')
    .map((c) => ({ ...c, coveredBy: text(c.coveredBy), note: text(c.note) }));
}

const COVERAGE_MARK: Record<string, string> = { covered: '✅', partial: '⚠️', 'not-satisfiable': '❌' };

interface FeedbackResponse { point: string; response: string; where: string; note: string }

/**
 * `point` is what makes an entry worth rendering, so it alone is filtered on.
 * `response` is then coerced rather than assumed: it is the one field the
 * renderer interpolates with no truthiness guard in front of it, and an entry
 * carrying a point but no response is exactly the shape a plan.json written
 * halfway through a revision has.
 */
function planFeedbackResponse(plan: Record<string, unknown> | null): FeedbackResponse[] {
  const v = plan?.feedbackResponse;
  if (!Array.isArray(v)) return [];
  return (v as FeedbackResponse[])
    .filter((f) => f && typeof f.point === 'string')
    .map((f) => ({ ...f, response: text(f.response), where: text(f.where), note: text(f.note) }));
}

/**
 * GitLab Markdown, not Slack mrkdwn.
 *
 * The two are close enough to look interchangeable and are not: Slack's
 * single-asterisk `*bold*` renders as literal asterisks on a ticket, and its
 * `:warning:` shortcode does not resolve at all. This gate posts to the
 * ticket, so everything here is standard Markdown.
 */
function renderPlanForTicket(plan: Record<string, unknown> | null): string {
  if (!plan) return '_(no plan recorded)_';
  const steps = planSteps(plan)
    .map((s) => `${s.n}. **[${mdText(s.layer)}]** ${mdText(s.what)}${s.files?.length ? ` — ${s.files.map(codeSpan).join(', ')}` : ''}`)
    .join('\n');
  const bullets = (key: PlanListKey): string => planList(plan, key).map((r) => `- ${mdText(r)}`).join('\n');
  const risks = bullets('risks');
  // Open questions sit ABOVE the steps: they are the decisions the approver is
  // actually being asked to make, and a plan that silently picked a scope reads
  // as settled when it is not. Empty sections are omitted, not labelled "none".
  const questions = bullets('openQuestions');
  const outOfScope = bullets('outOfScope');
  const coverage = planCoverage(plan)
    .map((c) => `- ${COVERAGE_MARK[c.status] ?? '•'} ${mdText(c.criterion)} — ${mdText(c.coveredBy || '—')}` +
      `${c.note ? ` _(${mdText(c.note)})_` : ''}`)
    .join('\n');
  // First on a revision: the approver's question is "did it take my points",
  // and the answer has to be checkable against the plan below, not asserted.
  const answered = planFeedbackResponse(plan)
    .map((f) => `- **${mdText(f.response)}** — ${mdText(f.point)}${f.where ? ` → ${mdText(f.where)}` : ''}` +
      `${f.note ? `: ${mdText(f.note)}` : ''}`)
    .join('\n');
  const approach = planStr(plan, 'approach');
  return `${answered ? `**Your feedback, point by point**\n${answered}\n\n` : ''}` +
    `**Approach**\n${approach ? mdText(approach) : '(not recorded)'}\n\n` +
    `${questions ? `**Open questions** — answer these in a comment, or the stated default is used\n${questions}\n\n` : ''}` +
    `**Steps**\n${steps || '(none recorded)'}\n\n` +
    `${coverage ? `**Acceptance coverage**\n${coverage}\n\n` : ''}` +
    `**Risks**\n${risks || '(none identified)'}` +
    `${outOfScope ? `\n\n**Out of scope**\n${outOfScope}` : ''}` +
    `${plan?.migrations === true ? '\n\n⚠️ includes a database migration' : ''}`;
}

/**
 * Who this gate is waiting on, named in the ask.
 *
 * Rendered as plain code spans rather than `@mentions`: an @mention on a
 * GitLab ticket sends a notification, and re-arming after every feedback round
 * would pile one on each reviewer per round. The list is here to answer "may I
 * approve this" without opening a config file, not to nag.
 */
function approverLine(gate: Gate): string {
  const who = approversFor(gate).map((u) => `\`@${u}\``).join(', ');
  return `Only ${GATE_ROLE[gate].toUpperCase()} may sign this off: ${who || '_(nobody configured)_'}.`;
}

/** Posted as a ticket comment when the plan gate first arms, or re-arms after feedback. */
export function planApprovalRequestBody(plan: Record<string, unknown> | null, why: string): string {
  return `**Oneshot pauses here** — ${why}\n\n${renderPlanForTicket(plan)}\n\n---\n\n` +
    `${approverLine('plan')}\n\n` +
    'Comment the single word **`approved`** to continue to `implement`. Any other comment from ' +
    'those accounts is treated as feedback and `plan` is re-run with it — there is no limit on ' +
    'how many rounds this can take. Comments from anyone else are ignored by this gate.';
}

/** The ticket's record that the plan was approved — audit only, posted after the decision. */
export function planApprovedRecordBody(): string {
  return 'Oneshot record: the plan above was approved on this ticket — proceeding to `implement`.';
}

// --------------------------------------------------------- testcases gate

function renderCasesForTicket(cases: TestCase[]): string {
  if (!cases.length) return '_(no test cases)_';
  // A table, not a bullet list. A reviewer's job at this gate is to scan thirty
  // or more cases and find the ones that are wrong, and a list of two-line
  // bullets makes the ids — the thing they have to quote back to ask for a
  // change — the hardest part to find. Columns put every id in one place and
  // every oracle in another.
  //
  // `tableCell`, not `mdText`: the prose here is model-authored and routinely
  // carries error strings, angle-bracketed tags and — fatally for a table —
  // pipes. tableCell runs mdText first, then escapes `|` and folds newlines to
  // `<br>`, which is the order that works (see gitlabmd.ts).
  const rows = cases.map(
    (c) => `| **${tableCell(c.id)}** | ${tableCell(c.blast)} | ${tableCell(c.scenario)} | ${tableCell(c.expected)} |`,
  );
  return ['| Case | Blast | Scenario | Expects |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/**
 * Posted as a ticket comment when the test-case gate first arms, or re-arms
 * after an edge case round.
 *
 * Deliberately carries no verdict: `qa` has not run yet at this point in the
 * pipeline, and inventing a summary for a phase that has not happened would be
 * worse than saying nothing. What is under review here is the LIST — what this
 * run intends to test — not a result.
 */
export function testcasesApprovalRequestBody(cases: TestCase[], why: string): string {
  return `**Oneshot pauses here** — ${why}\n\n` +
    `**Test cases to be verified** (${cases.length})\n${renderCasesForTicket(cases)}\n\n---\n\n` +
    `${approverLine('testcases')}\n\n` +
    'Comment the single word **`approved`** to continue to `review`.\n\n' +
    'Anything else is a REVISION request, and the list is rewritten to match it — so say what you ' +
    'want in plain words, naming the case by its id:\n\n' +
    '- **Add** — "Also check that an expired token is rejected."\n' +
    '- **Change** — "TC-07 should expect a 403, not a 401."\n' +
    '- **Remove** — "Drop TC-12, it duplicates TC-04."\n' +
    '- **Replace** — "TC-05 is too broad; split it into one case per announcement."\n\n' +
    'A case you ask to remove is removed, a case you ask to change is edited where it stands and ' +
    'keeps its id, and only genuinely new cases get new ids — so an id you quote today still names ' +
    'the same case in the next round. There is no limit on how many rounds this takes, and ' +
    'everything agreed here is tested by THIS run, before the MR is opened.\n\n' +
    'One exception to the plain-words rule: if you want to sign off AND add a case in the same ' +
    'comment, write the addition as a bullet (`- Verify that …`, optionally `— expects: …`). That ' +
    'round is appended to the approved list rather than rewriting it, which is why it needs the ' +
    'stricter shape.\n\n' +
    'Comments from anyone else are ignored by this gate.';
}

/** The ticket's record of the final, approved test-case list — audit only. */
export function testcasesApprovedRecordBody(cases: TestCase[]): string {
  return 'Oneshot record: the test-case list below was approved on this ticket — ' +
    'proceeding to `review`.\n\n' +
    `**Approved test cases** (${cases.length}):\n${renderCasesForTicket(cases)}`;
}

interface TestcasesArtifact {
  module?: string;
  lv?: string;
  cases?: TestCase[];
  passesEmpty?: string[];
}

/** Every appended edge case gets the same, deliberately unassuming tags — see `appendEdgeCases`. */
const EDGE_CASE_PASS_TAG = 'boundary';
const EDGE_CASE_BLAST: TestCase['blast'] = 'medium';

/**
 * The first free `TC-NN` number.
 *
 * Counting the list is not the same as reading it: a phase-4 list that skips
 * or renumbers an id at all — three cases numbered TC-01, TC-02, TC-04 —
 * makes `cases.length + 1` collide with an id already in the file, and two
 * cases sharing an id is a qa result that cannot be attributed to either.
 * Take the highest number actually present instead.
 */
function nextCaseNumber(cases: TestCase[]): number {
  const highest = cases.reduce((max, c) => {
    const m = /^TC-(\d+)$/.exec(c.id ?? '');
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return Math.max(highest, cases.length) + 1;
}

/**
 * Turn a qa-gate reply into one or more new `TestCase` entries and append
 * them to this run's `testcases.json` — the test-case gate's "anything but
 * `approved` is an edge case" rule, applied mechanically (this file never
 * runs a model).
 *
 * One case per case-shaped line — a bullet, or a line starting with a test
 * verb — parsed by `parseEdgeCases` (see edgecases.ts for why "every non-empty
 * line" was not good enough). `pass` and `blast` are not something free text
 * safely implies, so every appended case is tagged uniformly rather than
 * guessed — close enough to be found and re-run later without asserting a
 * category nobody actually stated.
 *
 * This IS "whatever rendered document represents" the test cases: nothing
 * else stores them. `publish.ts`'s CSV is rendered from this same JSON on
 * demand, never cached separately, so a testcases.json kept current is a CSV
 * kept current the next time anything publishes it.
 *
 * Returns the updated case list (for the next round's request body), or null
 * if this run has no testcases.json to append to.
 */
export function appendEdgeCases(iid: number, feedback: string): TestCase[] | null {
  const data = readArtifact<TestcasesArtifact>(iid, 'testcases.json');
  if (!data) return null;

  const cases = data.cases ?? [];
  const parsed = parseEdgeCases(feedback);
  if (!parsed.length) {
    log.info(`test-case gate reply on #${iid} carried no case-shaped lines — nothing appended`);
    return cases;
  }
  const first = nextCaseNumber(cases);
  const added: TestCase[] = parsed.map((c, idx) => {
    const n = first + idx;
    return {
      id: `TC-${String(n).padStart(2, '0')}`,
      scenario: c.scenario,
      precondition: '',
      steps: c.steps,
      expected: c.expected ?? `Matches the QA-reported edge case: ${c.steps[0]}`,
      pass: [EDGE_CASE_PASS_TAG],
      blast: EDGE_CASE_BLAST,
    };
  });

  const updated = [...cases, ...added];
  writeArtifact(iid, 'testcases.json', { ...data, cases: updated });
  return updated;
}

// ------------------------------------------------------------- design gate

/**
 * The `design` artifact, read as the fields these renderers want — same
 * defensive coercion as `planStr`/`planList` above, and for the same reason:
 * `mdText` calls `.replace` on what it is handed, so one absent field throws.
 */
function designOf(design: Record<string, unknown> | null): DesignArtifact {
  const d = (design ?? {}) as Partial<DesignArtifact>;
  return {
    applicable: d.applicable !== false,
    rationale: typeof d.rationale === 'string' ? d.rationale : '',
    flowChange: d.flowChange === true,
    tokensFile: typeof d.tokensFile === 'string' ? d.tokensFile : '',
    screens: Array.isArray(d.screens) ? d.screens : [],
    decisions: Array.isArray(d.decisions) ? d.decisions.map(String) : [],
    newPatterns: Array.isArray(d.newPatterns) ? d.newPatterns.map(String) : [],
    openQuestions: Array.isArray(d.openQuestions) ? d.openQuestions : [],
  };
}

/**
 * Everything the reviewer has to actually LOOK at, read off the run's artifact
 * directory.
 *
 * Order is the argument, exactly as it is in the ui-evidence pack: for each
 * screen the current state first and the proposal second, so a reviewer
 * scrolling the comment reads before→after per screen rather than a block of
 * one followed by a block of the other. Ordering follows the screens,
 * and the clickable file last — it is the thing you open if the pictures left
 * you with a question.
 *
 * A file the artifact names but disk does not have is skipped silently here
 * and named in the body by the renderer, which reads the same list: a gate
 * that refuses to arm over a missing screenshot parks the run in silence.
 */
export function designAttachments(iid: number, design: Record<string, unknown> | null): GateAttachment[] {
  const d = designOf(design);
  const dir = artifactDir(iid);
  const out: GateAttachment[] = [];
  // Two sets, because they answer different questions. `seen` is "have I
  // already attached this file", keyed on the artifact-relative path the
  // design named. `names` is "will the reviewer see two attachments called the
  // same thing", keyed on what GitLab will actually label them — and
  // design/a/shot.png and design/b/shot.png collide there while being
  // genuinely different files.
  const seen = new Set<string>();
  const names = new Set<string>();
  const push = (rel: string): void => {
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    const full = join(dir, rel);
    if (!existsSync(full)) return;
    const content = readFileSync(full);
    if (content.length > MAX_UPLOAD_BYTES) {
      log.warn(`design gate: ${rel} is too large to attach`, { iid, bytes: content.length });
      return;
    }
    const short = basename(rel);
    const name = names.has(short) ? rel.replace(/\//g, '-') : short;
    names.add(name);
    out.push({ name, content, mime: mimeFor(rel) });
  };
  for (const s of d.screens) {
    push(s.before);
    push(s.screenshot);
  }
  return out;
}

/**
 * Refuse a design that reports screens it never rendered.
 *
 * `designAttachments` drops a file disk does not have, deliberately and
 * silently: a gate that refuses to arm over one missing screenshot parks the
 * run in silence, which is the worse failure. But that tolerance applied to
 * EVERY screen produces a gate comment naming five screens with no images under
 * it, and a reviewer parked in front of nothing — reachable today, because the
 * phase reports its own success and nothing checks the artifact against disk.
 *
 * So the per-file tolerance stays where it is and the check moves up a level.
 * A design claiming screens must have rendered them. Returns null when there is
 * nothing to refuse: `applicable: false`, or no screens, is a complete answer.
 */
export function designDeliverableRefusal(
  iid: number, design: Record<string, unknown> | null,
): string | null {
  const d = designOf(design);
  if (!d.applicable || d.screens.length === 0) return null;
  const dir = artifactDir(iid);
  const missing = d.screens
    .filter((sc) => !sc.screenshot || !existsSync(join(dir, sc.screenshot)))
    .map((sc) => sc.id || sc.name || '(unnamed)');
  if (missing.length === 0) return null;
  const all = missing.length === d.screens.length;
  return `design reported ${d.screens.length} screen(s) and ${all ? 'none' : `${missing.length}`}`
    + ` of their renders are on disk: ${missing.join(', ')}.`
    + ' A design gate armed on screens nobody can see asks a reviewer to approve nothing.';
}

/**
 * GitLab Markdown, not Slack mrkdwn — same warning as `renderPlanForTicket`.
 *
 * What a design reviewer is being asked is narrower than what a plan reviewer
 * is asked, so this leads with the two things that decide the answer: the
 * choices that were made on their behalf, and anything invented that is not
 * already in the design system. The pictures are attached below the text by
 * the gate, because GitLab renders an uploaded image inline and a reviewer
 * scrolls to them naturally; repeating them as a list would be a caption
 * track for something already on screen.
 */
function renderDesignForTicket(design: Record<string, unknown> | null): string {
  const d = designOf(design);
  const bullets = (xs: string[]): string => xs.map((x) => `- ${mdText(x)}`).join('\n');
  const screens = d.screens
    .map((s) => `- **${mdText(s.name)}** — ${mdText(s.purpose)}`
      + `${s.states?.length ? ` _(${s.states.map(mdText).join(', ')})_` : ''}`
      + `${s.note ? `\n  - ${mdText(s.note)}` : ''}`)
    .join('\n');
  const questions = d.openQuestions
    .filter((q) => q && typeof q.q === 'string')
    .map((q) => `- ${mdText(q.q)}${q.recommendation ? ` — _recommended: ${mdText(q.recommendation)}_` : ''}`)
    .join('\n');

  return `**Screens** (${d.screens.length})\n${screens || '_(none recorded)_'}\n\n`
    + `${d.decisions.length ? `**Decisions worth your attention**\n${bullets(d.decisions)}\n\n` : ''}`
    + `${d.newPatterns.length
      ? `**New — needs approval**\nNot in the design system today. Approving the design approves these too.\n${bullets(d.newPatterns)}\n\n`
      : ''}`
    + `${questions ? `**Open questions** — answer in a comment, or the recommendation is used\n${questions}\n\n` : ''}`
    + (d.flowChange
      ? 'The flow spans more than one screen, so the mockups below are its states in order. '
        + 'A clickable prototype and a recorded walkthrough follow in a later change.\n'
      : 'Single screen, no flow change.\n');
}

/** Posted as a ticket comment when the design gate first arms, or re-arms after feedback. */
export function designApprovalRequestBody(design: Record<string, unknown> | null): string {
  return '**Oneshot pauses here** — this ticket carries **Design**, so the UI is agreed before '
    + 'it is built.\n\n'
    + `${renderDesignForTicket(design)}\n---\n\n`
    + `${approverLine('design')}\n\n`
    + 'Comment the single word **`approved`** to continue to `plan` and `implement` — what is '
    + 'approved here becomes the specification they build to, and the shipped screens are posted '
    + 'back against these on the MR. Any other comment from those accounts is treated as '
    + 'feedback and `design` is re-run with it, with no limit on how many rounds that takes. '
    + 'Comments from anyone else are ignored by this gate.';
}

/** The ticket's record that the design was approved — audit only, posted after the decision. */
export function designApprovedRecordBody(design: Record<string, unknown> | null): string {
  const d = designOf(design);
  const names = d.screens.map((s) => `\`${mdText(s.name)}\``).join(', ');
  return 'Oneshot record: the design above was approved on this ticket — proceeding to `plan`.'
    + `${names ? `\n\nApproved screens: ${names}.` : ''}`
    + `${d.newPatterns.length ? `\n\nApproved as new to the design system:\n${d.newPatterns.map((x) => `- ${mdText(x)}`).join('\n')}` : ''}`;
}

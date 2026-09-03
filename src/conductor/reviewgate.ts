/**
 * The opt-in `Review` label's two SESSION-side pause points: plan approval
 * (between phase 2 `plan` and phase 3 `implement`) and qa approval (between
 * phase 11 `qa` and phase 12 `demo`). The merge-readiness pre-check for phase
 * 9 is pure code and lives in codephases.ts instead, for the same reason
 * `merge` itself is code: no model should be involved in a gate that decides
 * whether the pipeline may proceed.
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
 */
import { DRY_RUN, projectConfig } from '../lib/config.js';
import {
  readJournal, updateJournal, type ReviewGateState, type RunJournal,
} from '../lib/artifacts.js';
import { addIssueNote, issueNotes } from '../lib/gitlab.js';
import { thread } from '../lib/slack.js';
import { log } from '../lib/log.js';

export type Gate = 'plan' | 'qa';
export type GateVerdict = 'approved' | 'feedback' | 'pending';

export interface GateResult {
  verdict: GateVerdict;
  /** Only set when verdict === 'feedback' — the reply text(s), newest included. */
  feedback?: string;
}

/** Whether this ticket opted into the review gates at all. Additive: absent label, no gates. */
export function reviewLabelPresent(labels: string[]): boolean {
  const label = projectConfig().labels.review;
  return Boolean(label) && labels.includes(label);
}

function isApprovedReply(body: string): boolean {
  // Exact match, case-insensitive, trimmed — deliberately NOT a substring
  // test. "approved, but see my comment above" is feedback, not a sign-off:
  // the whole point of requiring the bare word is that a reviewer who wants
  // changes cannot accidentally also approve them.
  return body.trim().toLowerCase() === 'approved';
}

/** Notes newer than `sinceId`, oldest first, with GitLab's own system notes and Oneshot's own notes excluded. */
async function newHumanNotes(
  iid: number, sinceId: number,
): Promise<Array<{ id: number; body: string }>> {
  const res = await issueNotes(iid);
  if (!res.ok || !res.data) return [];
  return res.data.filter((n) => n.id > sinceId && !n.system && !n.body.startsWith('Oneshot '));
}

/** Fallback "since" marker for a posted note whose response did not carry an id. */
async function latestNoteId(iid: number): Promise<number | null> {
  const res = await issueNotes(iid);
  if (!res.ok || !res.data?.length) return null;
  return Math.max(...res.data.map((n) => n.id));
}

function blankState(): ReviewGateState {
  return { requestNoteId: null, approved: false, feedback: [] };
}

function stateOf(j: RunJournal, gate: Gate): ReviewGateState {
  return (gate === 'plan' ? j.planApproval : j.qaApproval) ?? blankState();
}

function persist(iid: number, gate: Gate, state: ReviewGateState): RunJournal | null {
  return gate === 'plan' ? updateJournal(iid, { planApproval: state }) : updateJournal(iid, { qaApproval: state });
}

export interface CheckGateOpts {
  iid: number;
  gate: Gate;
  /** Posted as a fresh GitLab issue note the moment this gate first arms, or re-arms after feedback. */
  requestBody: string;
  /**
   * Invoked once — only the very first time this gate is ever armed for this
   * run, before the request note goes out. The qa gate uses it to re-surface
   * the test-cases artifact, which was already published back at phase 4 and
   * would otherwise never be shown again near the decision it is relevant to.
   */
  onFirstArm?: () => Promise<void>;
}

/**
 * One check of one gate. Never sleeps, never loops — see the file header.
 *
 * DRY_RUN auto-approves: a dry run is "watch the pipeline drive a real ticket
 * without touching it," and a GitLab issue note is exactly the write DRY_RUN
 * exists to suppress, so requiring a real human reply here would just wedge
 * the dry run forever waiting for something it can never ask for.
 */
export async function checkApprovalGate(opts: CheckGateOpts): Promise<GateResult> {
  const { iid, gate, requestBody, onFirstArm } = opts;

  if (DRY_RUN) {
    log.warn(`[dry-run] would pause at the '${gate}' review gate — auto-approving`, { iid });
    return { verdict: 'approved' };
  }

  const journal = readJournal(iid);
  if (!journal) return { verdict: 'pending' };

  let state = stateOf(journal, gate);

  if (state.requestNoteId === null) {
    const firstArm = state.feedback.length === 0;
    if (firstArm && onFirstArm) await onFirstArm();

    const posted = await addIssueNote(iid, requestBody);
    const noteId = posted.ok ? (posted.data?.id ?? await latestNoteId(iid)) : null;
    if (noteId === null) {
      log.warn(`${gate} approval request could not be posted — will retry next tick`, { iid });
      return { verdict: 'pending' };
    }

    state = { ...state, requestNoteId: noteId };
    persist(iid, gate, state);
    await thread(journal.slackTs ?? null,
      `*#${iid} — ${gate} review requested* — reply \`approved\` (exact word) on the ticket to ` +
      'continue, or reply with anything else to send it back with your feedback.');
    log.phase(`${gate} approval requested on #${iid}`, { noteId });
    return { verdict: 'pending' };
  }

  const notes = await newHumanNotes(iid, state.requestNoteId);
  const approvedNote = notes.find((n) => isApprovedReply(n.body));
  if (approvedNote) {
    state = { ...state, approved: true };
    persist(iid, gate, state);
    await thread(journal.slackTs ?? null, `*#${iid} — ${gate} approved.*`);
    log.ok(`${gate} approved on #${iid}`);
    return { verdict: 'approved' };
  }

  if (notes.length) {
    const feedback = notes.map((n) => n.body.trim()).filter(Boolean).join('\n\n');
    // requestNoteId resets to null: the NEXT check re-arms with a fresh
    // request note, so the reply that follows the revision is measured from
    // here rather than from the round that just ended.
    state = { requestNoteId: null, approved: false, feedback: [...state.feedback, feedback] };
    persist(iid, gate, state);
    await thread(journal.slackTs ?? null, `*#${iid} — ${gate} feedback received* — re-running with it.`);
    log.phase(`${gate} feedback received on #${iid}`, { rounds: state.feedback.length });
    return { verdict: 'feedback', feedback };
  }

  return { verdict: 'pending' };
}

export function planApprovalRequestBody(): string {
  return 'Oneshot pauses here — this ticket carries **Review**.\n\n' +
    'The plan above is ready for sign-off before `implement` starts. Reply with the single ' +
    'word **`approved`** to continue. Any other reply is treated as feedback and `plan` is ' +
    're-run with it — there is no limit on how many rounds this can take.';
}

export function qaApprovalRequestBody(qaSummary: string): string {
  return 'Oneshot pauses here — this ticket carries **Review**.\n\n' +
    `QA on the demo server: ${qaSummary}\n\n` +
    'Reply with the single word **`approved`** to continue to `demo`. Any other reply is ' +
    'treated as feedback and the ticket cycles back to `implement` with it (the same window a ' +
    'failing qa case already cycles) — there is no limit on how many rounds this can take.';
}

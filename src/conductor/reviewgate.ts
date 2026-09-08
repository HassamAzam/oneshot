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
 * GITLAB IS THE APPROVAL CHANNEL, and Slack is only told about it. A gate
 * posts its request as a ticket comment (`addIssueNote`) and polls that
 * ticket's comments for a reply from a named reviewer. If Slack is configured
 * the gate also drops a heads-up in the run's thread, but that post is
 * best-effort decoration: nothing is ever read back out of Slack, and a Slack
 * that is down, unconfigured or missing `channels:history` cannot stop a run.
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
import { DRY_RUN, projectConfig, reviewersConfig } from '../lib/config.js';
import {
  readArtifact, readJournal, updateJournal, writeArtifact,
  type ReviewGateState, type RunJournal,
} from '../lib/artifacts.js';
import { addIssueNote, issueNotes } from '../lib/gitlab.js';
import { slackEnabled, thread } from '../lib/slack.js';
import { log } from '../lib/log.js';
import type { TestCase } from '../phases/types.js';

export type Gate = 'plan' | 'testcases';
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
 * than a set of regexes nobody can read. Configured per project, and an empty
 * list turns the whole behaviour off.
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
const GATE_ROLE: Record<Gate, ReviewRole> = { plan: 'dev', testcases: 'qa' };

/** The GitLab usernames permitted to resolve this gate. */
function approversFor(gate: Gate): string[] {
  return reviewersConfig()[GATE_ROLE[gate]] ?? [];
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

function stateOf(j: RunJournal, gate: Gate): ReviewGateState {
  return (gate === 'plan' ? j.planApproval : j.testcasesApproval) ?? blankState();
}

function persist(iid: number, gate: Gate, state: ReviewGateState): RunJournal | null {
  return gate === 'plan'
    ? updateJournal(iid, { planApproval: state })
    : updateJournal(iid, { testcasesApproval: state });
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
  onApproved?: () => Promise<void>;
  /**
   * Invoked with the round's non-`approved` replies, BEFORE `onApproved` —
   * so a caller that folds feedback into an artifact (the test-case gate appending
   * edge cases to testcases.json) has already done so by the time the audit
   * record of what was approved is built from that same artifact.
   */
  onFeedback?: (feedback: string) => Promise<void>;
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
  const { iid, gate, requestBody, onApproved, onFeedback } = opts;

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
    const posted = await addIssueNote(iid, requestBody);
    if (!posted.ok || !posted.data) {
      log.warn(`${gate} approval request could not be posted to the ticket — will retry next tick`, { iid });
      return { verdict: 'pending' };
    }
    state = { ...state, requestNoteId: posted.data.id };
    persist(iid, gate, state);
    await notifySlack(journal, `*#${iid}* — Oneshot is waiting on \`${gate}\` approval on the ticket.`);
    log.phase(`${gate} approval requested on #${iid}`, { note: posted.data.id });
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
    };
    persist(iid, gate, state);
    if (onApproved) await onApproved();
    await notifySlack(journal, `*#${iid} — ${gate} approved by ${approver}.*`);
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
 */
async function notifySlack(journal: RunJournal, text: string): Promise<void> {
  if (!slackEnabled()) return;
  const ts = journal.slackTs ?? null;
  if (ts === null) return;
  try { await thread(ts, text); } catch { /* a missed heads-up is not a gate failure */ }
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

function planRisks(plan: Record<string, unknown> | null): string[] {
  const v = plan?.risks;
  return Array.isArray(v) ? v.map(String) : [];
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
    .map((s) => `${s.n}. **[${s.layer}]** ${s.what}${s.files?.length ? ` — \`${s.files.join('`, `')}\`` : ''}`)
    .join('\n');
  const risks = planRisks(plan).map((r) => `- ${r}`).join('\n');
  return `**Approach**\n${planStr(plan, 'approach') ?? '(not recorded)'}\n\n` +
    `**Steps**\n${steps || '(none recorded)'}\n\n` +
    `**Risks**\n${risks || '(none identified)'}` +
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
  return cases.map((c) => `- **${c.id}** [${c.blast}] ${c.scenario}\n  - _expects:_ ${c.expected}`).join('\n');
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
    'Comment the single word **`approved`** to continue to `review`. Any other comment from ' +
    'those accounts is treated as edge case(s) to add to this list — each line becomes a new ' +
    'case, appended to `testcases.json`, and this gate asks again with the updated list. There ' +
    'is no limit on how many rounds this can take. Anything added here is tested by THIS run, ' +
    'before the MR is opened. Comments from anyone else are ignored by this gate.';
}

/** The ticket's record of the final, approved test-case list — audit only. */
export function testcasesApprovedRecordBody(cases: TestCase[]): string {
  const lines = cases.map((c) => `- **${c.id}** [${c.blast}] ${c.scenario} — _expects:_ ${c.expected}`);
  return 'Oneshot record: the test-case list below was approved on this ticket — ' +
    'proceeding to `review`.\n\n' +
    `**Approved test cases** (${cases.length}):\n${lines.join('\n') || '_(none recorded)_'}`;
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
 * One case per non-empty line: that is the only structure a plain chat reply
 * reliably carries, since a reviewer listing three edge cases types them as
 * three lines, not as JSON. `pass` and `blast` are not something free text
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
  const lines = feedback.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = nextCaseNumber(cases);
  const added: TestCase[] = lines.map((line, idx) => {
    const n = first + idx;
    return {
      id: `TC-${String(n).padStart(2, '0')}`,
      scenario: /^verify that/i.test(line) ? line : `Verify that ${line}`,
      precondition: '',
      steps: [line],
      expected: `Matches the QA-reported edge case: ${line}`,
      pass: [EDGE_CASE_PASS_TAG],
      blast: EDGE_CASE_BLAST,
    };
  });

  const updated = [...cases, ...added];
  writeArtifact(iid, 'testcases.json', { ...data, cases: updated });
  return updated;
}

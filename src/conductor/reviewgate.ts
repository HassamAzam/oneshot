/**
 * The opt-in `Review` label's two SESSION-side pause points: plan approval
 * (between phase 2 `plan` and phase 3 `implement`) and qa approval (between
 * phase 11 `qa` and phase 12 `demo`). The merge-readiness pre-check for phase
 * 9 is pure code and lives in codephases.ts instead, for the same reason
 * `merge` itself is code: no model should be involved in a gate that decides
 * whether the pipeline may proceed.
 *
 * Slack is the PRIMARY approval channel here, not GitLab. A gate posts its
 * request as a reply in the ticket's existing Slack thread (`journal.slackTs`)
 * and polls that same thread for a human's reply. GitLab hears about a gate
 * only once it resolves — an `addIssueNote` audit record posted by the
 * caller's `onApproved` hook — never as the place a decision is read from.
 * That is a deliberate reversal of this file's first version, which posted
 * the request as a ticket comment and read GitLab notes for the reply: the
 * human who asked for this wants to work the approval in Slack, where the
 * plan or the test cases are already visible in the same thread as the run's
 * own status card, and wants the ticket to carry only a record of what was
 * decided.
 *
 * This file is deliberately NOT a polling loop. A check is one quick Slack
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
 * Reading a Slack reply back needs a scope this app did not previously need —
 * see `threadReplies()`'s own header in src/lib/slack.ts, and README's
 * "Optional human review gates" for the one-time Slack app configuration
 * change a human has to make.
 */
import { DRY_RUN, projectConfig } from '../lib/config.js';
import {
  readArtifact, readJournal, updateJournal, writeArtifact,
  type ReviewGateState, type RunJournal,
} from '../lib/artifacts.js';
import { thread, threadReplies } from '../lib/slack.js';
import { log } from '../lib/log.js';
import type { TestCase } from '../phases/types.js';

export type Gate = 'plan' | 'qa';
export type GateVerdict = 'approved' | 'feedback' | 'pending';

export interface GateResult {
  verdict: GateVerdict;
  /** Only set when verdict === 'feedback' — the reply text, newest included. */
  feedback?: string;
}

/** Whether this ticket opted into the review gates at all. Additive: absent label, no gates. */
export function reviewLabelPresent(labels: string[]): boolean {
  const label = projectConfig().labels.review;
  return Boolean(label) && labels.includes(label);
}

function isApprovedReply(text: string): boolean {
  // Exact match, case-insensitive, trimmed — deliberately NOT a substring
  // test. "approved, but see my comment above" is feedback, not a sign-off:
  // the whole point of requiring the bare word is that a reviewer who wants
  // changes cannot accidentally also approve them.
  return text.trim().toLowerCase() === 'approved';
}

function blankState(): ReviewGateState {
  return { requestTs: null, approved: false, feedback: [] };
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
  /**
   * Posted as a Slack thread reply the moment this gate first arms, or
   * re-arms after a feedback round. Built fresh by the caller on every check
   * (it embeds the current plan, or the current test-case list), never
   * cached here.
   */
  requestBody: string;
  /**
   * Invoked once, exactly on the transition into 'approved' — the caller's
   * chance to leave GitLab its audit record (`addIssueNote`) now that the
   * decision itself has already been made in Slack.
   */
  onApproved?: () => Promise<void>;
}

/**
 * One check of one gate. Never sleeps, never loops — see the file header.
 *
 * DRY_RUN auto-approves: a dry run is "watch the pipeline drive a real ticket
 * without touching it," and a Slack reply is exactly the human interaction
 * DRY_RUN exists to suppress, so requiring a real one here would just wedge
 * the dry run forever waiting for something it can never ask for.
 */
export async function checkApprovalGate(opts: CheckGateOpts): Promise<GateResult> {
  const { iid, gate, requestBody, onApproved } = opts;

  if (DRY_RUN) {
    log.warn(`[dry-run] would pause at the '${gate}' review gate — auto-approving`, { iid });
    return { verdict: 'approved' };
  }

  const journal = readJournal(iid);
  if (!journal) return { verdict: 'pending' };

  let state = stateOf(journal, gate);

  if (state.requestTs === null) {
    const ts = await thread(journal.slackTs ?? null, requestBody);
    if (ts === null) {
      log.warn(`${gate} approval request could not be posted to Slack — will retry next tick`, { iid });
      return { verdict: 'pending' };
    }
    state = { ...state, requestTs: ts };
    persist(iid, gate, state);
    log.phase(`${gate} approval requested on #${iid}`, { ts });
    return { verdict: 'pending' };
  }

  const replies = await threadReplies(journal.slackTs ?? '', state.requestTs);
  const approvedReply = replies.find((r) => isApprovedReply(r.text));
  if (approvedReply) {
    state = { ...state, approved: true };
    persist(iid, gate, state);
    if (onApproved) await onApproved();
    await thread(journal.slackTs ?? null, `*#${iid} — ${gate} approved.*`);
    log.ok(`${gate} approved on #${iid}`);
    return { verdict: 'approved' };
  }

  if (replies.length) {
    const feedback = replies.map((r) => r.text.trim()).filter(Boolean).join('\n');
    // requestTs resets to null: the NEXT check re-arms with a fresh request
    // reply, so the reply that follows the revision is measured from here
    // rather than from the round that just ended.
    state = { requestTs: null, approved: false, feedback: [...state.feedback, feedback] };
    persist(iid, gate, state);
    log.phase(`${gate} feedback received on #${iid}`, { rounds: state.feedback.length });
    return { verdict: 'feedback', feedback };
  }

  return { verdict: 'pending' };
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

function renderPlanForSlack(plan: Record<string, unknown> | null): string {
  if (!plan) return '_(no plan recorded)_';
  const steps = planSteps(plan)
    .map((s) => `${s.n}. *[${s.layer}]* ${s.what}${s.files?.length ? ` — \`${s.files.join('`, `')}\`` : ''}`)
    .join('\n');
  const risks = planRisks(plan).map((r) => `• ${r}`).join('\n');
  return `*Approach*\n${planStr(plan, 'approach') ?? '(not recorded)'}\n\n` +
    `*Steps*\n${steps || '(none recorded)'}\n\n` +
    `*Risks*\n${risks || '(none identified)'}` +
    `${plan?.migrations === true ? '\n\n:warning: includes a database migration' : ''}`;
}

/** Posted to the ticket's Slack thread when the plan gate first arms, or re-arms after feedback. */
export function planApprovalRequestBody(plan: Record<string, unknown> | null): string {
  return `Oneshot pauses here — this ticket carries *Review*.\n\n${renderPlanForSlack(plan)}\n\n` +
    'Reply with the single word *`approved`* to continue to `implement`. Any other reply is ' +
    'treated as feedback and `plan` is re-run with it — there is no limit on how many rounds ' +
    'this can take.';
}

/** The GitLab ticket's record of a plan approved in Slack — audit only, never the decision point. */
export function planApprovedRecordBody(): string {
  return 'Oneshot record: the plan above was approved in this ticket\'s Slack thread — ' +
    'proceeding to `implement`.';
}

// ---------------------------------------------------------------- qa gate

function renderCasesForSlack(cases: TestCase[]): string {
  if (!cases.length) return '_(no test cases)_';
  return cases.map((c) => `• *${c.id}* [${c.blast}] ${c.scenario}\n   _expects:_ ${c.expected}`).join('\n');
}

/** Posted to the ticket's Slack thread when the qa gate first arms, or re-arms after an edge case round. */
export function qaApprovalRequestBody(cases: TestCase[], qaSummary: string): string {
  return 'Oneshot pauses here — this ticket carries *Review*.\n\n' +
    `*QA on the demo server*: ${qaSummary}\n\n*Test cases*\n${renderCasesForSlack(cases)}\n\n` +
    'Reply with the single word *`approved`* to continue to `demo`. Any other reply is treated ' +
    'as edge case(s) to add to this list — each line becomes a new case, appended to ' +
    '`testcases.json`, and this gate asks again with the updated list. There is no limit on how ' +
    'many rounds this can take.';
}

/** The GitLab ticket's record of the final, approved test-case list — audit only. */
export function qaApprovedRecordBody(cases: TestCase[]): string {
  const lines = cases.map((c) => `- **${c.id}** [${c.blast}] ${c.scenario} — _expects:_ ${c.expected}`);
  return 'Oneshot record: QA was approved in this ticket\'s Slack thread — proceeding to `demo`.\n\n' +
    `**Final approved test cases** (${cases.length}):\n${lines.join('\n') || '_(none recorded)_'}`;
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
 * Turn a qa-gate reply into one or more new `TestCase` entries and append
 * them to this run's `testcases.json` — the qa gate's "anything but
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
  const added: TestCase[] = lines.map((line, idx) => {
    const n = cases.length + idx + 1;
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
